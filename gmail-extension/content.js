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

    // Close the popover on an outside click; keep it pinned under the icon as
    // the page scrolls / resizes.
    document.addEventListener("mousedown", (e) => {
      if (!rec || !rec.open) return;
      if (panelEl && panelEl.contains(e.target)) return;
      if (iconEl && iconEl.contains(e.target)) return;
      rec.open = false; rec.userToggled = true;
      applyPanelVisibility();
    }, true);
    const reflow = () => { if (rec && rec.open) positionPanel(); };
    window.addEventListener("scroll", reflow, true);
    window.addEventListener("resize", reflow);
  }

  // Live UI elements (persist across Gmail re-renders so listeners survive).
  let iconEl  = null;
  let panelEl = null;

  // ── Reconciliation engine ────────────────────────────────────────────────
  // A Gmail THREAD can carry MANY loads — a broker emails several weekday rate
  // cons (distinct loads) on one chain. So we don't lock after the first hit;
  // we keep watching as the thread + its attachments lazy-load and maintain a
  // live picture:
  //   • loads already linked to this thread (server),
  //   • loads we matched exactly (auto-linked),
  //   • rate-con PDFs not yet in FleetCal (offer Create — each PDF = one load,
  //     deduped by its primary order number).
  const FREIGHTY = /rate.?con|rate conf|confirmation|load tender|load conf|carrier|dispatch|new load|tender|\bbol\b|shipment|pickup|delivery|rate sheet/;
  let handledSig = null;
  let rec = null;   // per-email reconciliation state (see newRec)

  function newRec(sig, account, threadId, subjectEl) {
    return {
      sig, account, threadId, subjectEl,
      refs: [],                 // text refs found in subject/body
      trigger: false,           // does this look like a load email?
      loads:   new Map(),       // loadId -> { ref:CalendarRef, linked:bool }
      pdfs:    new Map(),       // url   -> { state, refs, primaryRef, filename, matched }
      linking: new Set(),       // loadIds with a setLink in flight (de-dupe)
      searchedRefs: new Set(),  // refs the AI extracted + searched (for display)
      lastText: "",             // last email text sent for AI extraction
      textCalls: 0,             // AI text extractions so far (cap per email)
      busy: 0,                  // in-flight searches (drives the "scanning" hint)
      allowExpand: false,       // ok to force-expand the thread (load email / Scan)
      expanded: false,          // have we force-expanded the thread's messages?
      untriggered: false,       // didn't look like a load email → show "Scan" button
      watching: false,          // have we started searching? (gates re-checks)
      open: false,              // is the popover showing?
      userToggled: false,       // user clicked the icon → stop auto-opening
    };
  }

  const stale = (sig) => sig !== handledSig;
  function panelLive(sig) {
    return panelEl && panelEl.dataset[PANEL_KEY] === sig ? panelEl : null;
  }

  function scan() {
    const subjectEl = document.querySelector(SUBJECT_SELECTOR);
    if (!subjectEl) { removeUI(); handledSig = null; rec = null; return; }

    const subject  = subjectEl.textContent.trim();
    const threadId = getThreadId();
    const account  = getAccount();
    const sig = subject.slice(0, 120) + "|" + (threadId || "");

    if (sig !== handledSig) {
      handledSig = sig;
      rec = newRec(sig, account, threadId, subjectEl);
      void reconcile();
      return;
    }

    if (!rec) return;
    // Keep refs fresh (Gmail recycles DOM).
    rec.subjectEl = subjectEl; rec.account = account; rec.threadId = threadId;

    // The conversation toolbar can render after we first drew — keep the icon
    // anchored there as it appears, and the popover pinned under it. The icon
    // shows on EVERY open email now (so you can link any of them).
    if (iconEl) { placeIcon(); if (rec.open) positionPanel(); }

    // Only watch once we've started searching (auto-triggered, linked, Scan).
    if (!rec.watching) return;

    // Gmail collapses middle messages in long threads — their bodies +
    // attachments aren't in the DOM until expanded. Force-expand once so the
    // whole thread renders and nothing stays hidden.
    if (rec.allowExpand && !rec.expanded && expandThread()) rec.expanded = true;

    // Re-search as later messages render: new attachments, or the body text
    // changed (a later message brought in a load number / a rate con).
    const newPdf = detectPdfAttachments().some((p) => !rec.pdfs.has(p.url));
    const text = `${subject}\n${readBody()}`.slice(0, 8000);
    const textChanged = text !== rec.lastText && rec.textCalls < MAX_TEXT_CALLS;
    if (newPdf || textChanged) void runSearch();   // idempotent (dedupes)
  }

  // Cap AI text extractions per email (initial collapsed view + one after the
  // thread expands is the usual case).
  const MAX_TEXT_CALLS = 4;

  // Force-render every message in the thread. Gmail's conversation toolbar has
  // an "Expand all" toggle that expands collapsed individual messages AND the
  // super-collapsed middle cluster. Clicking it flips the label to "Collapse
  // all", so it's naturally one-shot. Returns true if it clicked.
  function expandThread() {
    const btn = document.querySelector('[aria-label="Expand all"]');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  }

  // First pass for an email: existing links, trigger check, and — if it looks
  // like a load (or is already linked) — the text + PDF search. The icon shows
  // on EVERY email; an email that doesn't auto-trigger gets a "Scan" button.
  async function reconcile() {
    const { sig, account, threadId, subjectEl } = rec;
    const subject = subjectEl.textContent.trim();
    const body = readBody();
    const { refs, hasLabelled } = extractRefs(`${subject}\n${body}`);
    rec.refs = refs;
    const hasAlphaRef = refs.some((r) => /[A-Z]/.test(r));
    const pdfs0 = detectPdfAttachments();
    rec.trigger = emailHasLabel(subjectEl, LABEL_NAME) || hasLabelled || hasAlphaRef
      || FREIGHTY.test(subject.toLowerCase())
      || (pdfs0.length > 0 && FREIGHTY.test(pdfs0.map((p) => p.filename).join(" ").toLowerCase()));
    // Only force-expand the thread for emails that look like loads (where a
    // hidden rate con matters) — not every linked/incidental thread.
    rec.allowExpand = rec.trigger;

    renderRec();   // show the icon right away on any email

    // Loads already linked to this thread (array — a thread can have many).
    // Runs on EVERY email so a reply in a linked thread resolves instantly.
    if (account && threadId) {
      const link = await sendMsg({ type: "getLink", account, threadId }).catch(() => null);
      if (stale(sig)) return;
      // New API returns loads[]; tolerate an older single-load response too.
      const linked = (link && link.ok)
        ? (Array.isArray(link.loads) ? link.loads : (link.load ? [link.load] : []))
        : [];
      for (const l of linked) if (l && l.loadId) rec.loads.set(l.loadId, { ref: l, linked: true });
    }

    // Auto-search only when it looks like a load (or is already linked).
    // Otherwise show the "Scan for a load number" button and wait.
    if (rec.trigger || rec.loads.size) {
      await runSearch();
    } else {
      rec.untriggered = true;
      renderRec();
    }
  }

  // Search this email for loads: AI-extract the primary load number(s) from
  // the text + every rate con present. Idempotent — re-reads are deduped — so
  // it's safe to call again each time a collapsed message renders.
  async function runSearch() {
    if (!rec) return;
    rec.untriggered = false;
    rec.watching = true;

    // Expand collapsed messages so the whole thread is in the DOM, then read.
    if (rec.allowExpand && !rec.expanded && expandThread()) rec.expanded = true;

    await searchEmailText();

    const present = detectPdfAttachments();
    if (present.length) await searchNewPdfs(present);
    else renderRec();
  }

  // Let the AI pull the PRIMARY load number(s) out of the email text — so a
  // stray MC / DOT / phone never becomes a search and never wrong-links.
  // Skipped when the text is unchanged or the per-email call cap is hit.
  async function searchEmailText() {
    if (!rec) return;
    const subject = rec.subjectEl.textContent.trim();
    const text = `${subject}\n${readBody()}`.slice(0, 8000);
    if (text === rec.lastText || rec.textCalls >= MAX_TEXT_CALLS) return;
    rec.lastText = text;
    rec.textCalls++;
    const sig = rec.sig;
    rec.busy++; renderRec();
    const resp = await sendMsg({ type: "searchText", text }).catch(() => null);
    rec.busy--;
    if (stale(sig)) return;
    if (resp && resp.ok) {
      for (const r of (resp.refs || [])) rec.searchedRefs.add(r);   // for display
      for (const { load, ref } of exactLoadsFrom(resp.matches)) await addExact(load, ref);
    }
    renderRec();
  }

  // User asked us to check a non-triggered email for a load number.
  async function doScanNow() {
    if (!rec) return;
    rec.open = true;
    rec.allowExpand = true;   // an explicit scan may expand the thread
    renderRec();              // shows the "Scanning…" hint
    await runSearch();
  }

  // Search each NOT-yet-seen PDF on its own — every rate con is potentially a
  // distinct load. Records its extracted refs (primary first) so unmatched
  // ones can be deduped + offered for Create.
  async function searchNewPdfs(pdfs) {
    const sig = rec.sig;
    for (const pdf of pdfs.slice(0, 8)) {
      if (!rec.pdfs.has(pdf.url)) {
        rec.pdfs.set(pdf.url, { state: "pending", refs: [], primaryRef: null, filename: pdf.filename, matched: false });
      }
    }
    renderRec();

    for (const pdf of pdfs.slice(0, 8)) {
      const entry = rec.pdfs.get(pdf.url);
      if (!entry || entry.state !== "pending") continue;
      let resp = null;
      try {
        const b64 = await fetchPdfBase64(pdf.url);
        resp = await sendMsg({ type: "searchPdf", pdfBase64: b64 }).catch(() => null);
      } catch { /* fetch failed — leave unmatched */ }
      if (stale(sig)) return;
      entry.state = "done";
      entry.refs = (resp && resp.refs) || [];
      entry.primaryRef = entry.refs[0] || null;
      const exact = exactLoadsFrom(resp && resp.matches);
      entry.matched = exact.length > 0;
      for (const { load, ref } of exact) await addExact(load, ref);
      renderRec();
    }
  }

  // Pull the EXACT-match loads out of a search response's matches, deduped by
  // loadId. Exactness is judged against the ref that found each match.
  // (Fuzzy/coincidental hits are ignored — never auto-linked.)
  function exactLoadsFrom(matches) {
    const out = [];
    const seen = new Set();
    for (const m of matches || []) for (const l of m.loads || []) {
      if (l.loadId && !seen.has(l.loadId) && isExactMatch(l, m.ref)) { seen.add(l.loadId); out.push({ load: l, ref: m.ref }); }
    }
    return out;
  }

  // Record an exact-match load (and the ref that found it) and auto-link it.
  async function addExact(load, via) {
    if (!load.loadId) return;
    const existing = rec.loads.get(load.loadId);
    if (!existing) rec.loads.set(load.loadId, { ref: load, linked: false, via: via || null });
    else if (via && !existing.via) existing.via = via;
    if (rec.account && rec.threadId) await linkOne(load.loadId, "auto");
    renderRec();
  }

  // POST a (thread, load) link. Idempotent; de-dupes concurrent calls. Works
  // for a load not yet in rec.loads (a manual pick) — the response carries the
  // resolved calendar ref to display.
  async function linkOne(loadId, source) {
    if (!loadId || !rec) return;
    const entry = rec.loads.get(loadId);
    if ((entry && entry.linked) || rec.linking.has(loadId)) return;
    if (!rec.account || !rec.threadId) return;
    rec.linking.add(loadId);
    const resp = await sendMsg({ type: "setLink", account: rec.account, threadId: rec.threadId, loadId, source: source || "auto" }).catch(() => null);
    rec.linking.delete(loadId);
    if (resp && resp.ok && resp.load) rec.loads.set(loadId, { ref: resp.load, linked: true, via: entry ? entry.via : null });
    renderRec();
  }

  // Unmatched rate cons, deduped by primary order number (a rate con + its BOL
  // sharing an order number collapse to one). Returns [{url, primaryRef, …}].
  function unmatchedPdfs() {
    const out = [];
    const seen = new Set();
    for (const [url, p] of rec.pdfs) {
      if (p.state !== "done" || p.matched) continue;
      const key = p.primaryRef || url;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ url, ...p });
    }
    return out;
  }

  // Gmail attachment chips carry download_url = "mime:filename:url".
  function detectPdfAttachments() {
    const out = [];
    for (const el of document.querySelectorAll("[download_url]")) {
      const dl = el.getAttribute("download_url") || "";
      const i1 = dl.indexOf(":");
      const i2 = dl.indexOf(":", i1 + 1);
      if (i1 < 0 || i2 < 0) continue;
      const mime = dl.slice(0, i1);
      const filename = dl.slice(i1 + 1, i2);
      let url = dl.slice(i2 + 1);
      // Gmail sometimes prefixes the real URL (".../mail/u/0/https://...") —
      // the fetchable URL starts at the LAST https://.
      const h = url.lastIndexOf("https://");
      if (h > 0) url = url.slice(h);
      if (/pdf/i.test(mime) || /\.pdf$/i.test(filename)) out.push({ filename, url });
    }
    return out;
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Fetch the attachment (same-origin mail.google.com, cookies included) and
  // base64-encode it for the backend's Claude document block.
  async function fetchPdfBase64(url) {
    const res = await fetch(url, { credentials: "include" });
    if (!res.ok) throw new Error("attachment fetch " + res.status);
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let bin = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(bin);
  }

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

  // ── Panel UI: a toolbar icon + a toggleable popover ───────────────────────
  // FleetCal lives as an icon in the open conversation's top-right toolbar
  // (beside Print / Pop-out). Click it to show/hide the reconciliation
  // popover; a status dot on the icon gives state at a glance without opening.
  const ICON_SVG =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' +
    '<path d="m9 16 2 2 4-4"/></svg>';

  // Gmail's conversation toolbar buttons carry stable aria-labels — anchor to
  // one so we sit in the same row as Print / In-new-window.
  function findToolbarAnchor() {
    const labels = ["Print all", "In new window", "Show in a new window", "Collapse all", "Expand all"];
    for (const lbl of labels) {
      const el = document.querySelector(`[aria-label="${lbl}"]`);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  // Place the icon in the toolbar (just left of the anchor), or — if the
  // toolbar isn't there — beside the subject as a fallback.
  function placeIcon() {
    if (!iconEl) return;
    const anchor = findToolbarAnchor();
    if (anchor) {
      if (iconEl.parentElement !== anchor.parentElement || iconEl.nextElementSibling !== anchor) {
        anchor.parentElement.insertBefore(iconEl, anchor);
      }
      return;
    }
    if (iconEl.isConnected) return;
    const subj = document.querySelector(SUBJECT_SELECTOR);
    if (subj) {
      const host = subj.closest("div") || subj.parentElement;
      host?.parentElement?.insertBefore(iconEl, host);
    }
  }

  function ensureIcon() {
    if (!iconEl) {
      iconEl = document.createElement("div");
      iconEl.id = "fleetcal-icon";
      iconEl.className = "fc-icon";
      iconEl.setAttribute("role", "button");
      iconEl.setAttribute("tabindex", "0");
      iconEl.setAttribute("aria-label", "FleetCal — load reconciliation");
      iconEl.title = "FleetCal";
      iconEl.innerHTML = ICON_SVG + '<span class="fc-badge" hidden></span>';
      const toggle = (e) => { e.preventDefault(); e.stopPropagation(); togglePanel(); };
      iconEl.addEventListener("click", toggle);
      iconEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") toggle(e); });
    }
    placeIcon();
    return iconEl;
  }

  function ensurePanel() {
    if (!panelEl) {
      panelEl = document.createElement("div");
      panelEl.id = PANEL_ID;
      panelEl.className = "fc-pop";
      panelEl.hidden = true;
      panelEl.innerHTML =
        '<div class="fc-head"><span class="fc-logo">FleetCal</span>' +
        '<span class="fc-refs"></span>' +
        '<button type="button" class="fc-close" data-fc="close" aria-label="Close">✕</button></div>' +
        '<div class="fc-body"></div>';
      panelEl.addEventListener("click", onPanelClick);
      document.body.appendChild(panelEl);
    }
    return panelEl;
  }

  // One delegated click handler for everything the popover does.
  function onPanelClick(e) {
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
    const fc = btn.dataset.fc;
    if (fc === "close")     { if (rec) { rec.open = false; rec.userToggled = true; } applyPanelVisibility(); }
    if (fc === "scan")      void doScanNow();
    if (fc === "link")      void linkOne(btn.dataset.loadid, "manual-pick");
    if (fc === "unlinkone") void doUnlinkOne(btn.dataset.loadid);
    if (fc === "createone") void doCreateFromUrls([btn.dataset.url]);
    if (fc === "createall") void doCreateFromUrls(unmatchedPdfs().map((u) => u.url));
    if (fc === "manual") {
      const val = panelEl.querySelector(".fc-manual-input")?.value.trim();
      if (val) void doManualLink(val);
    }
  }

  // Ensure both icon + panel exist; returns the panel element.
  function ensureUI() {
    ensureIcon();
    const panel = ensurePanel();
    panel.dataset[PANEL_KEY] = rec.sig;
    panel.dataset.account = rec.account || "";
    panel.dataset.thread  = rec.threadId || "";
    return panel;
  }

  function togglePanel() {
    if (!rec) return;
    rec.open = !rec.open;
    rec.userToggled = true;
    applyPanelVisibility();
  }

  function applyPanelVisibility() {
    if (!panelEl) return;
    const open = !!(rec && rec.open);
    panelEl.hidden = !open;
    if (iconEl) iconEl.classList.toggle("fc-open", open);
    if (open) positionPanel();
  }

  // Pin the popover under the icon, its right edge aligned to the icon's,
  // clamped into the viewport.
  function positionPanel() {
    if (!panelEl || !iconEl || !iconEl.isConnected) return;
    const r = iconEl.getBoundingClientRect();
    panelEl.style.top   = `${Math.round(r.bottom + 6)}px`;
    panelEl.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
    panelEl.style.left  = "auto";
  }

  function removeUI() {
    if (iconEl)  { iconEl.remove();  iconEl = null; }
    if (panelEl) { panelEl.remove(); panelEl = null; }
  }

  function setPanelBody(panel, html) {
    const body = panel.querySelector(".fc-body");
    if (body) body.innerHTML = html;
  }

  // Calendar deep link for a load — its event (pickup leg for relays). The
  // linked ref carries eventId; a raw search/PDF result carries it as `id`.
  // Only fall back to the load-detail page when there's genuinely no event.
  function calendarHref(load) {
    const eventId = load.eventId ?? load.id ?? null;
    if (eventId) {
      return `${APP_BASE}/calendar?event=${encodeURIComponent(eventId)}` +
        (load.start ? `&date=${encodeURIComponent(String(load.start).slice(0, 10))}` : "");
    }
    return load.internalLoadId != null ? `${APP_BASE}/loads/${load.internalLoadId}` : null;
  }

  function loadLabel(load) {
    // Show the broker's load number (what you'd recognize from the email),
    // falling back to the internal id only if there's no load number.
    return load.loadNum || (load.internalLoadId != null ? `#${load.internalLoadId}` : "load");
  }

  // Normalize a reference for exact comparison (upper-case, strip spaces/dashes;
  // keep leading zeros so "0015997" ≠ "15997").
  const normRef = (s) => String(s ?? "").toUpperCase().replace(/[\s-]/g, "");

  // Is this load an EXACT match for the searched ref? Prefer the server's
  // matchExact flag (it also covers a ref_nums hit), but fall back to a
  // client-side check on the load number / internal id so auto-linking still
  // works if the API hasn't been redeployed with the matchExact change.
  function isExactMatch(l, ref) {
    if (!l) return false;
    if (l.exact === true || l.matchExact === true) return true;
    const q = normRef(ref);
    if (!q) return false;
    // Match the broker-facing load number ONLY. NOT internal_load_id — that's
    // FleetCal's sequential id, which a stray number in the email (a phone,
    // a date, a tracking #) collides with and wrongly auto-links.
    if (l.loadNum != null && normRef(l.loadNum) === q) return true;
    return false;
  }

  // Draw the whole multi-load picture for the open email: every linked /
  // in-system load (each with its own calendar link + unlink), every rate con
  // not yet in FleetCal (Create — one per distinct order number, plus a
  // "Create all N" when there's more than one), and a scanning hint while the
  // thread's attachments are still loading.
  function renderRec() {
    if (!rec) return;
    const panel = ensureUI();
    if (!panel) return;

    const loads = [...rec.loads.values()];
    const unmatched = unmatchedPdfs();
    // "pending" only means a search is actually in flight (we're watching).
    const pending = rec.watching && (
      rec.busy > 0 || [...rec.pdfs.values()].some((p) => p.state === "pending"));

    // Status drives the icon badge + the one-time auto-open.
    let status = "none";
    if (pending) status = "scan";
    else if (unmatched.length) status = "action";
    else if (loads.length) status = "linked";
    setIconStatus(status, unmatched.length || loads.length || 0);

    // Auto-open once when there's something to act on (rate cons to create) OR
    // the thread is already linked — so a linked load surfaces on its own.
    // Respect the user once they've toggled the panel.
    if ((status === "action" || status === "linked") && !rec.userToggled && !rec.open) rec.open = true;

    // Header refs.
    const refsEl = panel.querySelector(".fc-refs");
    if (refsEl) { const s = [...rec.searchedRefs]; refsEl.textContent = s.length ? s.join(" · ") : ""; }

    // Untriggered email (didn't look like a load, nothing linked, not yet
    // scanned) → offer to scan it + a manual link box.
    if (rec.untriggered && loads.length === 0 && rec.pdfs.size === 0 && !pending) {
      let h = `<div class="fc-row fc-muted">No load number detected in this email.</div>
        <div class="fc-row"><button type="button" class="fc-btn-go" data-fc="scan">Scan for a load number →</button></div>`;
      if (rec.account && rec.threadId) {
        h += `<div class="fc-row"><input class="fc-manual-input" placeholder="or link a load # / ref" />
             <button type="button" class="fc-btn-link" data-fc="manual">link</button></div>`;
      }
      setPanelBody(panel, h);
      applyPanelVisibility();
      return;
    }

    let html = "";

    for (const { ref, linked, via } of loads) {
      const href = calendarHref(ref);
      const link = href
        ? `<a class="fc-link" href="${href}" target="_blank" rel="noopener">open ${escapeHtml(loadLabel(ref))} on calendar →</a>`
        : `<span>${escapeHtml(loadLabel(ref))}</span>`;
      const broker = ref.broker ? `<span class="fc-via">${escapeHtml(ref.broker)}</span>` : "";
      // Show WHICH searched ref matched, but only when it differs from the
      // load number (i.e. matched on a ref number) — so a surprising link is
      // obvious and you can unlink it.
      const viaTxt = (via && normRef(via) !== normRef(ref.loadNum))
        ? `<span class="fc-via">via ${escapeHtml(via)}</span>` : "";
      const tail = linked
        ? `<button type="button" class="fc-btn-link" data-fc="unlinkone" data-loadid="${escapeHtml(ref.loadId)}">unlink</button>`
        : (rec.account ? "" : `<span class="fc-via">set account to link</span>`);
      html += `<div class="fc-row fc-ok">✓ ${linked ? "Linked" : "In system"} ${link}${broker}${viaTxt} ${tail}</div>`;
    }

    if (unmatched.length) {
      if (unmatched.length > 1) {
        html += `<div class="fc-row"><button type="button" class="fc-btn-go" data-fc="createall">Create ${unmatched.length} loads from rate cons →</button></div>`;
      }
      for (const u of unmatched) {
        const label = escapeHtml(u.primaryRef || u.filename || "rate con");
        const cls = unmatched.length > 1 ? "fc-btn-link" : "fc-btn-go";
        const txt = unmatched.length > 1 ? "Create" : "Create load from rate con →";
        html += `<div class="fc-row fc-warn">⚠ ${label} — not in FleetCal <button type="button" class="${cls}" data-fc="createone" data-url="${escapeHtml(u.url)}">${txt}</button></div>`;
      }
    }

    if (pending) html += `<div class="fc-row fc-muted">Scanning the thread…</div>`;

    if (!html && !pending) html = `<div class="fc-row fc-warn">⚠ Not in FleetCal</div>`;

    // Always show exactly what we searched — so weird extracted numbers (and
    // any wrong match they produced) are visible. Capped so a long expanded
    // thread doesn't overflow the panel.
    const searched = [...rec.searchedRefs];
    if (searched.length) {
      const shown = searched.slice(0, 12).map(escapeHtml).join(", ");
      const more = searched.length > 12 ? ` +${searched.length - 12} more` : "";
      html += `<div class="fc-row fc-muted">Searched: ${shown}${more}</div>`;
    }

    // Manual-link escape hatch — link a load whose number FleetCal stores
    // differently than the email shows.
    if (rec.account && rec.threadId && !pending) {
      html += `<div class="fc-row"><input class="fc-manual-input" placeholder="link another load # / ref" />
           <button type="button" class="fc-btn-link" data-fc="manual">link</button></div>`;
    }

    setPanelBody(panel, html);
    applyPanelVisibility();
  }

  // Reflect status on the icon's badge dot: blue=scanning, amber=action
  // needed (rate cons to create), green=linked/in-system, hidden=nothing.
  function setIconStatus(status, count) {
    if (!iconEl) return;
    const badge = iconEl.querySelector(".fc-badge");
    if (!badge) return;
    iconEl.classList.remove("fc-st-scan", "fc-st-action", "fc-st-linked");
    if (status === "none") { badge.hidden = true; badge.textContent = ""; return; }
    iconEl.classList.add(status === "scan" ? "fc-st-scan" : status === "action" ? "fc-st-action" : "fc-st-linked");
    badge.hidden = false;
    badge.textContent = status === "scan" ? "" : String(count || "");
  }

  // ── Link / unlink / create actions ───────────────────────────────────────
  async function doUnlinkOne(loadId) {
    if (!loadId || !rec) return;
    await sendMsg({ type: "unlink", account: rec.account, threadId: rec.threadId, loadId }).catch(() => null);
    rec.loads.delete(loadId);
    renderRec();
  }

  // Manual link: search a typed value, then link the exact match (or the sole
  // result the user clearly meant). Adds to the thread's set — doesn't replace.
  async function doManualLink(value) {
    if (!rec) return;
    const panel = panelLive(rec.sig);
    const resp = await sendMsg({ type: "search", refs: [value] }).catch(() => null);
    const loads = [];
    for (const m of (resp && resp.matches) || []) for (const l of m.loads || []) loads.push(l);
    if (!loads.length) {
      panel?.querySelector(".fc-body")?.insertAdjacentHTML("beforeend",
        `<div class="fc-row fc-warn">No load found for "${escapeHtml(value)}".</div>`);
      return;
    }
    const exact = loads.filter((l) => isExactMatch(l, value));
    const pick = exact[0] || (loads.length === 1 ? loads[0] : null);
    if (pick && pick.loadId) {
      if (!rec.loads.has(pick.loadId)) rec.loads.set(pick.loadId, { ref: pick, linked: false });
      await linkOne(pick.loadId, "manual");
      return;
    }
    // Ambiguous — list candidates with link buttons.
    const rows = loads.slice(0, 6).map((l) =>
      `<div class="fc-row fc-muted">${escapeHtml(loadLabel(l))}${l.broker ? ` · ${escapeHtml(l.broker)}` : ""} <button type="button" class="fc-btn-link" data-fc="link" data-loadid="${escapeHtml(l.loadId || "")}">link</button></div>`).join("");
    panel?.querySelector(".fc-body")?.insertAdjacentHTML("beforeend", rows);
  }

  // Create load(s) from the given rate-con PDF url(s): fetch each, hand the
  // batch to the FleetCal calendar tab, which runs the AI parse + opens the
  // (multi-item) review modal.
  async function doCreateFromUrls(urls) {
    if (!rec) return;
    const list0 = [...new Set((urls || []).filter(Boolean))];
    const panel = panelLive(rec.sig);
    if (!list0.length) { if (panel) setPanelBody(panel, `<div class="fc-row fc-warn">No PDF attachment found.</div>`); return; }
    if (panel) setPanelBody(panel, `<div class="fc-row fc-muted">Sending ${list0.length} rate con${list0.length > 1 ? "s" : ""} to FleetCal…</div>`);
    try {
      const pdfList = [];
      for (const url of list0) { try { pdfList.push(await fetchPdfBase64(url)); } catch { /* skip unreadable */ } }
      if (!pdfList.length) { if (panel) setPanelBody(panel, `<div class="fc-row fc-warn">Couldn't read the attachment(s).</div>`); return; }
      // Keep the real failure reason — don't collapse it to a generic message.
      const resp = await sendMsg({ type: "createLoads", pdfList })
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (!panel) return;
      if (resp && resp.ok) {
        const note = resp.reloading
          ? `<div class="fc-row fc-muted">Reloading your calendar to open the review…</div>`
          : `<div class="fc-row fc-muted">Re-open this email after saving to link them to the thread.</div>`;
        setPanelBody(panel, `<div class="fc-row fc-ok">✓ Opened ${pdfList.length} in FleetCal — review &amp; save.</div>${note}`);
      } else {
        let msg = (resp && resp.error) || "Couldn't start the load";
        if (/context invalidated|establish connection|Receiving end|orphan/i.test(msg)) {
          msg = "Extension was reloaded — refresh this Gmail tab (and your FleetCal tab) and retry.";
        }
        setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(msg)}</div>`);
      }
    } catch (e) {
      if (panel) setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(String(e?.message || e))}</div>`);
    }
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
