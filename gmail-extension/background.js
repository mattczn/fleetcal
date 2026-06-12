// background.js — FleetCal Gmail reconciliation service worker
//
// All FleetCal API traffic goes through here, NOT the content script. Two
// reasons:
//   1. CORS — a fetch from the content script carries Origin:
//      https://mail.google.com, which the FleetCal API's allow-list rejects.
//      The extension background worker, granted host_permissions for the API
//      domain, makes cross-origin requests without that restriction.
//   2. Secret hygiene — the bot key lives only in the worker + chrome.storage,
//      never in the page's JS world. The content script just asks for results.
//
// Protocol: content script sends { type: "search", refs: string[] }; we
// search each ref against the bot loads endpoint and reply with per-ref
// matches.

const SEARCH_PATH = "/v1/bot/loads/search";

// Cap concurrent ref lookups so a noisy email (many candidate tokens) can't
// hammer the API. Small pool, plenty for a single email.
const CONCURRENCY = 4;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "search") {
    handleSearch(msg.refs || [])
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // async reply
  }
  if (msg?.type === "open" && msg.url) {
    openInFleetcalTab(msg.url)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  if (msg?.type === "getLink") {
    threadLink("GET", msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "setLink") {
    threadLink("POST", msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "unlink") {
    threadLink("DELETE", msg).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "searchPdf") {
    searchPdf(msg.pdfBase64).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "searchText") {
    searchText(msg.text).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "linkedThreads") {
    linkedThreads(msg.account, msg.legacyIds || []).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "createLoad") {
    createLoadsFromPdfs([msg.pdfBase64]).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  if (msg?.type === "createLoads") {
    createLoadsFromPdfs(msg.pdfList || []).then(sendResponse).catch((err) => sendResponse({ ok: false, error: errStr(err) }));
    return true;
  }
  return false;
});

// Hand a rate-con PDF to the FleetCal calendar tab to start a new load in
// the in-app review flow. Requires a FleetCal calendar tab to be open (the
// create/review modal only lives there).
async function createLoadsFromPdfs(pdfList) {
  const list = (pdfList || []).filter(Boolean);
  if (!list.length) return { ok: false, error: "No rate con to create from." };

  // Stage first so every delivery path has a fallback: the bridge's
  // deliverPendingCreate reads this from storage on a fresh /calendar load.
  try { await chrome.storage.local.set({ pendingCreatePdfs: { list, ts: Date.now() } }); }
  catch (e) { return { ok: false, error: "Couldn't stage the rate cons: " + errStr(e) }; }

  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { /* ignore */ }
  const calTab = tabs.find((t) => {
    try {
      const u = new URL(t.url);
      return normHost(u.hostname) === "fleetcal.app" && u.pathname.startsWith("/calendar");
    } catch { return false; }
  });
  const appBase = await getAppBase();

  // No calendar tab open → open one; the bridge picks up the staged list.
  if (!calTab) {
    await chrome.tabs.create({ url: appBase + "/calendar" });
    return { ok: true, opening: true, count: list.length };
  }

  await chrome.tabs.update(calTab.id, { active: true });
  if (calTab.windowId != null) {
    try { await chrome.windows.update(calTab.windowId, { focused: true }); } catch { /* ignore */ }
  }

  // Try in-place delivery via the bridge (no reload).
  const delivered = await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(calTab.id, { type: "createFromPdfs", pdfList: list }, (resp) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!(resp && resp.ok));
      });
    } catch { resolve(false); }
  });
  if (delivered) {
    // Page handled it inline (doesn't read storage) — drop the staged copy so
    // a future reload doesn't re-fire it.
    try { await chrome.storage.local.remove("pendingCreatePdfs"); } catch { /* ignore */ }
    return { ok: true, count: list.length };
  }

  // Bridge unreachable (commonly an orphaned content script after an extension
  // reload). Reload the tab to /calendar; the fresh bridge delivers the staged
  // list from storage. This self-heals instead of erroring.
  await chrome.tabs.update(calTab.id, { url: appBase + "/calendar" });
  return { ok: true, reloading: true, count: list.length };
}

function getAppBase() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["appBase"], (cfg) => {
      resolve((cfg.appBase || "https://fleetcal.app").replace(/\/+$/, ""));
    });
  });
}

// Send a rate-con PDF (base64) to the backend, which AI-extracts its
// reference numbers and searches. Returns { ok, refs, matches }.
async function searchPdf(pdfBase64) {
  const { apiBase, botKey } = await getConfig();
  if (!apiBase) return { ok: false, error: "Not configured." };
  const res = await fetch(`${apiBase}/v1/bot/loads/search-pdf`, {
    method: "POST",
    headers: { ...(botKey ? { "x-bot-key": botKey } : {}), "content-type": "application/json" },
    body: JSON.stringify({ pdfBase64 }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, ...data };
}

// AI-extract the primary load number(s) from email text + search them.
async function searchText(text) {
  const { apiBase, botKey } = await getConfig();
  if (!apiBase) return { ok: false, error: "Not configured." };
  const res = await fetch(`${apiBase}/v1/bot/loads/search-text`, {
    method: "POST",
    headers: { ...(botKey ? { "x-bot-key": botKey } : {}), "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, ...data };
}

const LINK_PATH = "/v1/bot/email-thread";

// One helper for all three thread-link verbs. Returns the parsed JSON with
// an `ok` flag merged in. account/threadId go in the query for GET/DELETE,
// the body for POST.
async function threadLink(method, msg) {
  const { apiBase, botKey } = await getConfig();
  if (!apiBase) return { ok: false, error: "Not configured." };
  const headers = botKey ? { "x-bot-key": botKey } : {};
  let url = `${apiBase}${LINK_PATH}`;
  let body;
  if (method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify({
      account:        msg.account,
      threadId:       msg.threadId,
      loadId:         msg.loadId,
      legacyThreadId: msg.legacyThreadId || null,
      source:         msg.source || "auto",
      linkedBy:       msg.account,
    });
  } else {
    const params = { account: msg.account || "", threadId: msg.threadId || "" };
    if (msg.loadId) params.loadId = msg.loadId;   // DELETE one load (else whole thread)
    url += `?${new URLSearchParams(params).toString()}`;
  }
  const res = await fetch(url, { method, headers, body });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, ...data };
}

// Ask which of these inbox-row thread ids (Gmail legacy hex ids) are linked.
async function linkedThreads(account, legacyIds) {
  const { apiBase, botKey } = await getConfig();
  if (!apiBase) return { ok: false, linked: [] };
  const res = await fetch(`${apiBase}${LINK_PATH}/linked`, {
    method: "POST",
    headers: { ...(botKey ? { "x-bot-key": botKey } : {}), "content-type": "application/json" },
    body: JSON.stringify({ account, legacyIds }),
  });
  let data = {};
  try { data = await res.json(); } catch { /* ignore */ }
  return { ok: res.ok, ...data };
}

function errStr(e) { return String((e && e.message) || e); }

// Reuse an existing FleetCal tab if one is open: navigate it to the URL
// and focus it. Otherwise open a new tab. The target's origin (derived
// from the URL itself) is the match pattern, so this follows whatever
// app URL the extension is configured with.
async function openInFleetcalTab(url) {
  let target = null;
  try { target = new URL(url); } catch { /* ignore */ }
  const wantHost = target ? normHost(target.hostname) : null;
  const eventId  = target?.searchParams.get("event");
  const date     = target?.searchParams.get("date");

  // Query ALL tabs and match by normalized hostname (www-insensitive). Reading
  // tab.url requires the "tabs" permission — if undefined here, accept that
  // permission on chrome://extensions after the reload.
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { /* ignore */ }
  const match = wantHost && tabs.find((t) => {
    try { return normHost(new URL(t.url).hostname) === wantHost; } catch { return false; }
  });

  if (!match) { await chrome.tabs.create({ url }); return; }

  // Focus the existing tab.
  await chrome.tabs.update(match.id, { active: true });
  if (match.windowId != null) {
    try { await chrome.windows.update(match.windowId, { focused: true }); } catch { /* ignore */ }
  }

  // If it's already on the calendar, open the event IN-PLACE via the bridge
  // content script — no full page reload. From any other page, navigate
  // (you're changing pages anyway).
  const onCalendar = (() => { try { return new URL(match.url).pathname.startsWith("/calendar"); } catch { return false; } })();
  if (eventId && onCalendar) {
    const delivered = await sendOpenEvent(match.id, eventId, date);
    if (delivered) return;
  }
  await chrome.tabs.update(match.id, { url });
}

// Ask the bridge content script in the tab to open the event in-place.
// Resolves false if the bridge isn't there (then the caller navigates).
function sendOpenEvent(tabId, eventId, date) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "openEvent", eventId, date }, (resp) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!(resp && resp.ok));
      });
    } catch { resolve(false); }
  });
}

function normHost(h) {
  return String(h || "").replace(/^www\./, "").toLowerCase();
}

async function handleSearch(refs) {
  const { apiBase, botKey } = await getConfig();
  if (!apiBase) return { ok: false, error: "Not configured — open the extension and set the API base + bot key." };

  const unique = [...new Set(refs.map((r) => String(r).trim()).filter((r) => r.length >= 2))];
  const results = await pMap(unique, CONCURRENCY, (ref) => searchOne(apiBase, botKey, ref));

  // Flatten to: { ok, matches: [{ ref, loads:[{internalLoadId, loadNum, broker}] }], searched }
  const matches = results.filter((r) => r.loads.length > 0);
  return { ok: true, searched: unique, matches };
}

async function searchOne(apiBase, botKey, ref) {
  const url = `${apiBase}${SEARCH_PATH}?q=${encodeURIComponent(ref)}&limit=5`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: botKey ? { "x-bot-key": botKey } : {},
    });
    if (!res.ok) return { ref, loads: [], error: `HTTP ${res.status}` };
    const data = await res.json(); // { loads: Load[] }
    const loads = (data.loads || []).map((l) => ({
      loadId:         l.loadId ?? l.load_id ?? null,   // uuid — needed to create a thread link
      internalLoadId: l.internalLoadId ?? l.internal_load_id ?? null,
      loadNum:        l.loadNum ?? l.load_num ?? null,
      broker:         l.broker ?? null,
      // event id + start drive the calendar deep link (pickup leg for
      // relays — the bot search returns that leg).
      eventId:        l.id ?? null,
      start:          l.start ?? null,
      // Did the load's OWN number/ref equal the searched ref? Only exact
      // hits are safe to auto-link (substring/coincidence matches aren't).
      exact:          l.matchExact === true,
    }));
    return { ref, loads };
  } catch (err) {
    return { ref, loads: [], error: String(err && err.message || err) };
  }
}

function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["apiBase", "botKey"], (cfg) => {
      resolve({
        apiBase: (cfg.apiBase || "").replace(/\/+$/, ""),
        botKey:  cfg.botKey || "",
      });
    });
  });
}

// Tiny concurrency-limited map — no deps.
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}
