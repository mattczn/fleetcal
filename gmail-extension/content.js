// content.js — FleetCal load reconciliation, in-email panel.
//
// When you OPEN an email carrying your "New Load" label, this:
//   1. reads the subject + body text,
//   2. extracts candidate reference / load numbers,
//   3. asks the background worker to search FleetCal for each,
//   4. injects a panel: ✓ already in FleetCal (with a link) or ⚠ not found.
//
// It works on the open-email view (not the list) because reliable ref
// extraction needs the full body, and that's also where you'll act on it.
//
// Gmail obfuscates + reshuffles class names. The selectors below are the
// fragile bits — if detection stops working, see README "Tuning selectors".
(() => {
  "use strict";

  // ---- Selectors most likely to need tuning across Gmail versions ----------
  const SUBJECT_SELECTOR = "h2.hP";   // open-conversation subject
  const BODY_SELECTOR    = ".a3s";    // a message body block (one per message)
  // --------------------------------------------------------------------------

  const PANEL_ID  = "fleetcal-panel";
  const PANEL_KEY = "fleetcalKey";   // dataset on the panel = current email signature

  let LABEL_NAME  = "new load";      // matched case-insensitively, trimmed
  let APP_BASE    = "https://fleetcal.app";
  let CFG_ACCOUNT = "";              // optional gmail-account override (popup fallback)

  chrome.storage.sync.get(["labelName", "appBase", "gmailAccount"], (cfg) => {
    if (cfg.labelName)    LABEL_NAME  = String(cfg.labelName).trim().toLowerCase();
    if (cfg.appBase)      APP_BASE    = String(cfg.appBase).replace(/\/+$/, "");
    if (cfg.gmailAccount) CFG_ACCOUNT = String(cfg.gmailAccount).trim().toLowerCase();
    start();
  });

  function start() {
    scan();
    const obs = new MutationObserver(debounce(scan, 400));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // The email view currently handled — guards against the MutationObserver
  // re-running the whole flow (incl. API calls) on every DOM mutation.
  let handledSig = null;

  function scan() {
    const subjectEl = document.querySelector(SUBJECT_SELECTOR);
    if (!subjectEl) { removePanel(); handledSig = null; return; }    // no email open

    const subject  = subjectEl.textContent.trim();
    const threadId = getThreadId();
    const account  = getAccount();
    const sig = subject.slice(0, 120) + "|" + (threadId || "");
    if (sig === handledSig) return;                                   // already handled
    handledSig = sig;
    void handle(subjectEl, subject, sig, account, threadId);
  }

  async function handle(subjectEl, subject, sig, account, threadId) {
    const body = readBody();
    const { refs, hasLabelled } = extractRefs(`${subject}\n${body}`);
    // An alphanumeric ref (WE11117, L-204517) is a distinctive freight
    // reference on its own — unlike a bare number it's unlikely to be a
    // phone/date — so it triggers even without a "Load #"-style keyword.
    const hasAlphaRef = refs.some((r) => /[A-Z]/.test(r));
    const refTrigger  = emailHasLabel(subjectEl, LABEL_NAME) || hasLabelled || hasAlphaRef;

    // 1) Already linked? Resolve instantly. Keyed on (account, thread) since
    //    Gmail thread ids are per-mailbox. Works even on no-ref replies in
    //    the same conversation.
    if (account && threadId) {
      const link = await sendMsg({ type: "getLink", account, threadId }).catch(() => null);
      if (stale(sig)) return;
      if (link && link.ok && link.linked && link.load) {
        renderLinked(renderPanel(subjectEl, sig, refs, account, threadId), link.load);
        return;
      }
    }

    // 2) Not linked + doesn't look like a load email → stay silent.
    if (!refTrigger) { removePanel(); return; }

    const panel = renderPanel(subjectEl, sig, refs, account, threadId);

    // 2a) Load email but no ref in the text (number only in the PDF, etc.)
    //     — offer a manual link.
    if (!refs.length) { renderNotFound(panel, [], account, threadId); return; }

    // 2b) Search by the extracted refs; auto-link a single confident match.
    setPanelBody(panel, `<div class="fc-row fc-muted">Searching FleetCal…</div>`);
    const resp = await sendMsg({ type: "search", refs }).catch(() => ({ ok: false, error: "Extension was reloaded — refresh this Gmail tab." }));
    if (stale(sig)) return;
    const live = document.getElementById(PANEL_ID);
    if (!live || live.dataset[PANEL_KEY] !== sig) return;
    await renderSearch(live, refs, resp, account, threadId);
  }

  const stale = (sig) => sig !== handledSig;

  // ── Label detection ────────────────────────────────────────────────────
  // Applied labels render as chips (div.at[title="…"] + a .av text node) in
  // the open conversation. They're NOT close to the subject in the DOM, so we
  // scope to the conversation pane ([role="main"]) — which is the open email
  // when you're reading one — and scan it for a chip matching the label.
  function emailHasLabel(subjectEl, want) {
    // Scan the whole document for a label chip, but SKIP inbox-list rows
    // (tr.zA) — those carry labels for background threads and would
    // false-positive. What's left is reading-pane label chips, which only
    // exist on Gmail layouts that show applied labels inside the open
    // email. (On layouts that don't — like the one this was tested on —
    // this returns false and the labelled-ref trigger takes over.)
    const candidates = document.querySelectorAll("[title], .at, .av, .ar");
    for (const el of candidates) {
      if (el.closest("tr.zA")) continue;
      const t = (el.getAttribute("title") || el.textContent || "").trim().toLowerCase();
      if (t === want) return true;
    }
    return false;
  }

  function readBody() {
    const blocks = document.querySelectorAll(BODY_SELECTOR);
    let text = "";
    blocks.forEach((b) => { text += "\n" + (b.innerText || b.textContent || ""); });
    return text;
  }

  // ── Reference extraction ──────────────────────────────────────────────
  // Two passes: labelled tokens (preferred), then standalone id-looking
  // tokens. Permissive on purpose — a non-load token just returns no match
  // from the search, so false candidates are harmless. We dedupe + cap so a
  // noisy email can't fan out into dozens of API calls.
  const LABELLED = /\b(?:load|ref(?:erence)?|pro|order|bol|shipment|confirmation|conf|trip|po|pickup)\b[\s#:.\-]*((?:[A-Z]{1,5}[-\s]?)?\d[\dA-Z\-]{3,18})/gi;
  const STANDALONE = /\b([A-Z]{0,4}-?\d{5,12})\b/g;
  const MAX_REFS = 10;

  function extractRefs(text) {
    const seen = new Set();
    const out = [];
    const push = (raw) => {
      const tok = raw.replace(/\s+/g, "").toUpperCase().replace(/[-.]+$/, "");
      if (tok.length < 4 || tok.length > 24) return false;
      if (seen.has(tok)) return false;
      seen.add(tok);
      out.push(tok);
      return true;
    };

    // Labelled pass first — a number next to load/ref/order/etc. Its
    // presence is also the panel's trigger (see scan), so track it.
    let hasLabelled = false;
    let m;
    while ((m = LABELLED.exec(text)) !== null) { if (push(m[1])) hasLabelled = true; }
    while ((m = STANDALONE.exec(text)) !== null && out.length < MAX_REFS * 2) push(m[1]);

    return { refs: out.slice(0, MAX_REFS), hasLabelled };
  }

  // ── Panel rendering ───────────────────────────────────────────────────
  function renderPanel(subjectEl, signature, refs, account, threadId) {
    removePanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset[PANEL_KEY] = signature;
    panel.dataset.account = account || "";
    panel.dataset.thread  = threadId || "";
    panel.innerHTML = `
      <div class="fc-head">
        <span class="fc-logo">FleetCal</span>
        <span class="fc-refs">${refs.length ? refs.map(escapeHtml).join(" · ") : "—"}</span>
      </div>
      <div class="fc-body"></div>`;

    // One delegated click handler for everything the panel does:
    //  • a.fc-link        → open in FleetCal (reusing an existing tab)
    //  • [data-fc=link]   → link this thread to a load
    //  • [data-fc=unlink] → remove the link
    //  • [data-fc=manual] → link by a typed load # / ref
    panel.addEventListener("click", (e) => {
      const a = e.target.closest("a.fc-link");
      if (a) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
        e.preventDefault();
        chrome.runtime.sendMessage({ type: "open", url: a.href });
        return;
      }
      const btn = e.target.closest("[data-fc]");
      if (!btn) return;
      e.preventDefault();
      const acct = panel.dataset.account, thread = panel.dataset.thread;
      if (btn.dataset.fc === "link")   void doLink(panel, acct, thread, btn.dataset.loadid, "manual-pick");
      if (btn.dataset.fc === "unlink") void doUnlink(panel, acct, thread, subjectEl, signature);
      if (btn.dataset.fc === "manual") {
        const val = panel.querySelector(".fc-manual-input")?.value.trim();
        if (val) void doManualLink(panel, acct, thread, val);
      }
    });

    // Insert just above the subject's container.
    const host = subjectEl.closest("div") || subjectEl.parentElement;
    host.parentElement.insertBefore(panel, host);
    return panel;
  }

  function setPanelBody(panel, html) {
    const body = panel.querySelector(".fc-body");
    if (body) body.innerHTML = html;
  }

  // Calendar deep link for a load — its event (pickup leg for relays).
  function calendarHref(load) {
    if (load.eventId) {
      return `${APP_BASE}/calendar?event=${encodeURIComponent(load.eventId)}` +
        (load.start ? `&date=${encodeURIComponent(String(load.start).slice(0, 10))}` : "");
    }
    return load.internalLoadId != null ? `${APP_BASE}/loads/${load.internalLoadId}` : null;
  }

  function loadLabel(load) {
    return load.internalLoadId != null ? `#${load.internalLoadId}` : (load.loadNum || "load");
  }

  // A linked thread — the persistent ✓ state. Shows the calendar link + unlink.
  function renderLinked(panel, load) {
    const href = calendarHref(load);
    const link = href
      ? `<a class="fc-link" href="${href}" target="_blank" rel="noopener">open ${loadLabel(load)} on calendar →</a>`
      : `<span>${loadLabel(load)}</span>`;
    const broker = load.broker ? `<span class="fc-via">${escapeHtml(load.broker)}</span>` : "";
    setPanelBody(panel,
      `<div class="fc-row fc-ok">✓ Linked ${link}${broker}</div>
       <div class="fc-row"><button type="button" class="fc-btn-link" data-fc="unlink">unlink</button></div>`);
  }

  // Search results. A found load AUTO-LINKS — no manual step. Only the
  // not-found case asks for input (attachment-only emails).
  async function renderSearch(panel, refs, resp, account, threadId) {
    if (!resp || !resp.ok) {
      setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(resp?.error || "Search failed")}</div>`);
      return;
    }
    const byLoad = new Map();
    for (const match of resp.matches || []) {
      for (const load of match.loads) {
        const key = load.loadId ?? load.internalLoadId ?? `${load.loadNum}-${load.broker}`;
        if (!byLoad.has(key)) byLoad.set(key, { load, ref: match.ref });
      }
    }
    const found = [...byLoad.values()];

    if (found.length === 0) { renderNotFound(panel, refs, account, threadId); return; }

    // Auto-link the (best/first) match. The bot search already collapses
    // relay legs to one row per load, so a single load = one entry.
    const primary = found[0].load;
    if (account && threadId && primary.loadId) {
      await doLink(panel, account, threadId, primary.loadId, "auto");
      // doLink re-renders as ✓ Linked on success, or an error otherwise.
      // If the email referenced more than one distinct load, note the rest.
      if (found.length > 1) {
        const extras = found.slice(1).map(({ load }) => {
          const href = calendarHref(load);
          return href ? `<div class="fc-row fc-muted">also matched <a class="fc-link" href="${href}" target="_blank" rel="noopener">${escapeHtml(loadLabel(load))}</a></div>` : "";
        }).join("");
        if (extras) panel.querySelector(".fc-body")?.insertAdjacentHTML("beforeend", extras);
      }
      return;
    }

    // Can't link (no account/thread detected) — still show status, and hint
    // how to enable auto-linking.
    const rows = found.map(({ load, ref }) => {
      const href = calendarHref(load);
      const link = href ? `<a class="fc-link" href="${href}" target="_blank" rel="noopener">open ${loadLabel(load)} on calendar →</a>` : `<span>${loadLabel(load)}</span>`;
      const broker = load.broker ? ` · ${escapeHtml(load.broker)}` : "";
      return `<div class="fc-row fc-ok">✓ In system ${link}<span class="fc-via">via ${escapeHtml(ref)}${broker}</span></div>`;
    });
    const hint = !account
      ? `<div class="fc-row fc-muted">Set your Gmail account in the extension to auto-link this thread.</div>`
      : "";
    setPanelBody(panel, rows.join("") + hint);
  }

  function renderNotFound(panel, refs, account, threadId) {
    const searched = refs.length ? `<div class="fc-row fc-muted">Searched: ${refs.map(escapeHtml).join(", ")}</div>` : "";
    const manual = (account && threadId)
      ? `<div class="fc-row"><input class="fc-manual-input" placeholder="link to load # / ref" />
           <button type="button" class="fc-btn-go" data-fc="manual">Link</button></div>`
      : "";
    setPanelBody(panel,
      `<div class="fc-row fc-warn">⚠ Not in FleetCal</div>${searched}${manual}`);
  }

  // ── Link actions ────────────────────────────────────────────────────────
  async function doLink(panel, account, threadId, loadId, source) {
    const resp = await sendMsg({ type: "setLink", account, threadId, loadId, source }).catch(() => null);
    if (resp && resp.ok && resp.linked && resp.load) { renderLinked(panel, resp.load); return true; }
    setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(resp?.error || "Link failed")}</div>`);
    return false;
  }

  async function doUnlink(panel, account, threadId, subjectEl, signature) {
    setPanelBody(panel, `<div class="fc-row fc-muted">Unlinking…</div>`);
    await sendMsg({ type: "unlink", account, threadId }).catch(() => null);
    // Re-run the flow so it falls back to a fresh search.
    handledSig = null;
    scan();
    void subjectEl; void signature;
  }

  async function doManualLink(panel, account, threadId, value) {
    setPanelBody(panel, `<div class="fc-row fc-muted">Looking up "${escapeHtml(value)}"…</div>`);
    const resp = await sendMsg({ type: "search", refs: [value] }).catch(() => null);
    const loads = [];
    for (const match of (resp && resp.matches) || []) for (const l of match.loads) loads.push(l);
    if (loads.length === 1 && loads[0].loadId) { await doLink(panel, account, threadId, loads[0].loadId, "manual"); return; }
    if (loads.length === 0) { setPanelBody(panel, `<div class="fc-row fc-warn">No load found for "${escapeHtml(value)}".</div>${manualInput()}`); return; }
    // Multiple — list them with link buttons.
    const rows = loads.map((l) =>
      `<div class="fc-row fc-ok">${escapeHtml(loadLabel(l))}${l.broker ? ` · ${escapeHtml(l.broker)}` : ""} <button type="button" class="fc-btn-link" data-fc="link" data-loadid="${escapeHtml(l.loadId || "")}">link</button></div>`);
    setPanelBody(panel, rows.join(""));
  }
  function manualInput() {
    return `<div class="fc-row"><input class="fc-manual-input" placeholder="link to load # / ref" /><button type="button" class="fc-btn-go" data-fc="manual">Link</button></div>`;
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  // ── thread + account identity ────────────────────────────────────────────
  // Gmail puts the open thread's id as the last segment of the URL hash:
  //   #inbox/FMfcgz…   #label/New+Load/FMfcg…   #search/…/FMfcg…
  // It's an opaque, per-mailbox id — as long as we use the same value when
  // we link and when we look up, the format doesn't matter. Folder names
  // ("inbox") are short, so require a minimum length.
  function getThreadId() {
    const seg = (location.hash || "").split("/").pop() || "";
    return seg.length >= 10 ? decodeURIComponent(seg) : null;
  }

  // The active Gmail account (email). Config override wins; otherwise pull it
  // from an aria-label (the account switcher reads "Google Account: … (you@x)").
  function getAccount() {
    if (CFG_ACCOUNT) return CFG_ACCOUNT;
    for (const el of document.querySelectorAll('[aria-label*="@"]')) {
      const m = (el.getAttribute("aria-label") || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
      if (m) return m[0].toLowerCase();
    }
    return null;
  }

  // Promise wrapper around sendMessage that surfaces orphaned-context errors
  // (extension reloaded without refreshing Gmail) instead of hanging.
  function sendMsg(msg) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000);
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          resolve(resp);
        });
      } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  // ── utils ──────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
})();
