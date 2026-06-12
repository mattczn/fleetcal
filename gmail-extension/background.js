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
  return false;
});

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
      account:  msg.account,
      threadId: msg.threadId,
      loadId:   msg.loadId,
      source:   msg.source || "auto",
      linkedBy: msg.account,
    });
  } else {
    const qs = new URLSearchParams({ account: msg.account || "", threadId: msg.threadId || "" });
    url += `?${qs.toString()}`;
  }
  const res = await fetch(url, { method, headers, body });
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
  let wantHost = null;
  try { wantHost = normHost(new URL(url).hostname); } catch { /* ignore */ }

  // Query ALL tabs and match by normalized hostname (www-insensitive) so
  // an existing fleetcal.app / www.fleetcal.app tab is reused regardless
  // of the exact origin pattern. Reading tab.url requires the "tabs"
  // permission — if a tab's url is undefined here, that permission isn't
  // granted (accept it on chrome://extensions after the reload).
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { /* ignore */ }
  const match = wantHost && tabs.find((t) => {
    try { return normHost(new URL(t.url).hostname) === wantHost; } catch { return false; }
  });

  if (match) {
    await chrome.tabs.update(match.id, { url, active: true });
    if (match.windowId != null) {
      try { await chrome.windows.update(match.windowId, { focused: true }); } catch { /* ignore */ }
    }
  } else {
    await chrome.tabs.create({ url });
  }
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
