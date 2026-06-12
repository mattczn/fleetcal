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
  return false;
});

// Reuse an existing FleetCal tab if one is open: navigate it to the URL
// and focus it. Otherwise open a new tab. The target's origin (derived
// from the URL itself) is the match pattern, so this follows whatever
// app URL the extension is configured with.
async function openInFleetcalTab(url) {
  let pattern;
  try { pattern = new URL(url).origin + "/*"; } catch { pattern = null; }
  const tabs = pattern ? await chrome.tabs.query({ url: pattern }) : [];
  if (tabs.length) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { url, active: true });
    if (tab.windowId != null) {
      try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* ignore */ }
    }
  } else {
    await chrome.tabs.create({ url });
  }
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
