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

  const PANEL_ID    = "fleetcal-panel";
  const PANEL_KEY   = "fleetcalKey";  // dataset key on the panel = current email signature

  let LABEL_NAME = "new load";        // matched case-insensitively, trimmed
  let APP_BASE   = "https://fleetcal.app";

  chrome.storage.sync.get(["labelName", "appBase"], (cfg) => {
    if (cfg.labelName) LABEL_NAME = String(cfg.labelName).trim().toLowerCase();
    if (cfg.appBase)   APP_BASE   = String(cfg.appBase).replace(/\/+$/, "");
    start();
  });

  function start() {
    scan();
    const obs = new MutationObserver(debounce(scan, 400));
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function scan() {
    const subjectEl = document.querySelector(SUBJECT_SELECTOR);
    if (!subjectEl) { removePanel(); return; }            // no email open

    const subject = subjectEl.textContent.trim();
    const signature = subject.slice(0, 120);              // cheap per-email key
    const existing = document.getElementById(PANEL_ID);
    if (existing && existing.dataset[PANEL_KEY] === signature) return; // already done this email

    if (!emailHasLabel(subjectEl, LABEL_NAME)) { removePanel(); return; }

    const body = readBody();
    const refs = extractRefs(`${subject}\n${body}`);

    const panel = renderPanel(subjectEl, signature, refs);
    if (!refs.length) {
      setPanelBody(panel, `<div class="fc-row fc-muted">No reference numbers detected in this email.</div>`);
      return;
    }

    setPanelBody(panel, `<div class="fc-row fc-muted">Searching FleetCal for ${refs.length} reference${refs.length === 1 ? "" : "s"}…</div>`);
    chrome.runtime.sendMessage({ type: "search", refs }, (resp) => {
      // Panel may have been replaced if the user navigated mid-flight.
      const live = document.getElementById(PANEL_ID);
      if (!live || live.dataset[PANEL_KEY] !== signature) return;
      renderResult(live, refs, resp);
    });
  }

  // ── Label detection ────────────────────────────────────────────────────
  // Applied labels render as chips in the conversation header near the
  // subject. Walk up a few ancestors from the subject and scan that subtree
  // for a chip whose title/text equals the label.
  function emailHasLabel(subjectEl, want) {
    let scope = subjectEl;
    for (let i = 0; i < 4 && scope.parentElement; i++) scope = scope.parentElement;
    const candidates = scope.querySelectorAll("[title], .at, .av, .ar");
    for (const el of candidates) {
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
      if (tok.length < 4 || tok.length > 24) return;
      if (seen.has(tok)) return;
      seen.add(tok);
      out.push(tok);
    };

    let m;
    while ((m = LABELLED.exec(text)) !== null) push(m[1]);
    while ((m = STANDALONE.exec(text)) !== null && out.length < MAX_REFS * 2) push(m[1]);

    return out.slice(0, MAX_REFS);
  }

  // ── Panel rendering ───────────────────────────────────────────────────
  function renderPanel(subjectEl, signature, refs) {
    removePanel();
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.dataset[PANEL_KEY] = signature;
    panel.innerHTML = `
      <div class="fc-head">
        <span class="fc-logo">FleetCal</span>
        <span class="fc-refs">${refs.length ? refs.map(escapeHtml).join(" · ") : "—"}</span>
      </div>
      <div class="fc-body"></div>`;
    // Insert just above the subject's container so it sits at the top of the
    // open email without overlapping the toolbar.
    const host = subjectEl.closest("div") || subjectEl.parentElement;
    host.parentElement.insertBefore(panel, host);
    return panel;
  }

  function setPanelBody(panel, html) {
    const body = panel.querySelector(".fc-body");
    if (body) body.innerHTML = html;
  }

  function renderResult(panel, refs, resp) {
    if (!resp || !resp.ok) {
      setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(resp?.error || "Search failed")}</div>`);
      return;
    }
    if (!resp.matches.length) {
      setPanelBody(
        panel,
        `<div class="fc-row fc-warn">⚠ Not in FleetCal</div>
         <div class="fc-row fc-muted">Searched: ${refs.map(escapeHtml).join(", ")}</div>`
      );
      return;
    }
    // De-dupe matched loads across refs (a ref + load_num may both hit the
    // same load). Key by internalLoadId.
    const byLoad = new Map();
    for (const match of resp.matches) {
      for (const load of match.loads) {
        const key = load.internalLoadId ?? `${load.loadNum}-${load.broker}`;
        if (!byLoad.has(key)) byLoad.set(key, { load, ref: match.ref });
      }
    }
    const rows = [...byLoad.values()].map(({ load, ref }) => {
      const label = load.internalLoadId != null ? `#${load.internalLoadId}` : (load.loadNum || "load");
      const broker = load.broker ? ` · ${escapeHtml(load.broker)}` : "";
      const href = load.internalLoadId != null ? `${APP_BASE}/loads/${load.internalLoadId}` : null;
      const link = href
        ? `<a class="fc-link" href="${href}" target="_blank" rel="noopener">open ${label} →</a>`
        : `<span>${label}</span>`;
      return `<div class="fc-row fc-ok">✓ In system ${link}<span class="fc-via">via ${escapeHtml(ref)}${broker}</span></div>`;
    });
    setPanelBody(panel, rows.join(""));
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
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
