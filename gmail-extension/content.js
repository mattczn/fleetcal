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

  // Per-email tracking. Gmail loads thread messages + their attachments
  // progressively, so we don't process once-and-lock; we keep watching and
  // search each attachment as it appears (until something matches).
  const FREIGHTY = /rate.?con|rate conf|confirmation|load tender|load conf|carrier|dispatch|new load|tender|\bbol\b|shipment|pickup|delivery|rate sheet/;
  let handledSig = null;
  let emailState = "idle";          // idle | pending | searching | open | found | linked | quiet
  let searchedPdfUrls = new Set();  // PDFs already sent for this email
  let ctx = null;                   // { subjectEl, subject, sig, account, threadId, refs }

  const stale = (sig) => sig !== handledSig;
  function panelLive(sig) {
    const p = document.getElementById(PANEL_ID);
    return p && p.dataset[PANEL_KEY] === sig ? p : null;
  }

  function scan() {
    const subjectEl = document.querySelector(SUBJECT_SELECTOR);
    if (!subjectEl) { removePanel(); handledSig = null; emailState = "idle"; return; }

    const subject  = subjectEl.textContent.trim();
    const threadId = getThreadId();
    const account  = getAccount();
    const sig = subject.slice(0, 120) + "|" + (threadId || "");

    if (sig !== handledSig) {
      handledSig = sig;
      emailState = "pending";
      searchedPdfUrls = new Set();
      ctx = { subjectEl, subject, sig, account, threadId, refs: [] };
      void handle();
      return;
    }

    // Same email. Keep the element ref fresh (Gmail recycles DOM). Once
    // we've resolved positively or while a request is in flight, do nothing.
    if (ctx) { ctx.subjectEl = subjectEl; ctx.account = account; ctx.threadId = threadId; }
    if (emailState !== "open") return;

    // Watch for newly-loaded attachments (later messages in the thread) and
    // search them — this is what catches a rate con on a message that wasn't
    // rendered when the email first opened.
    const fresh = detectPdfAttachments().filter((p) => !searchedPdfUrls.has(p.url));
    if (fresh.length) void runPdfSearch(fresh);
  }

  async function handle() {
    const { subjectEl, subject, sig, account, threadId } = ctx;
    const body = readBody();
    const { refs, hasLabelled } = extractRefs(`${subject}\n${body}`);
    ctx.refs = refs;
    const hasAlphaRef = refs.some((r) => /[A-Z]/.test(r));
    const refTrigger  = emailHasLabel(subjectEl, LABEL_NAME) || hasLabelled || hasAlphaRef;
    const pdfs0 = detectPdfAttachments();
    const pdfTrigger = FREIGHTY.test(subject.toLowerCase())
      || (pdfs0.length > 0 && FREIGHTY.test(pdfs0.map((p) => p.filename).join(" ").toLowerCase()));

    // 1) Already linked? Resolve instantly (per account+thread).
    if (account && threadId) {
      const link = await sendMsg({ type: "getLink", account, threadId }).catch(() => null);
      if (stale(sig)) return;
      if (link && link.ok && link.linked && link.load) {
        renderLinked(renderPanel(subjectEl, sig, refs, account, threadId), link.load);
        emailState = "linked";
        return;
      }
    }

    // 2) Doesn't look like a load email → stay quiet (and stop watching).
    if (!refTrigger && !pdfTrigger) { removePanel(); emailState = "quiet"; return; }

    const panel = renderPanel(subjectEl, sig, refs, account, threadId);

    // 3) Text refs first (cheap, no AI).
    if (refs.length) {
      setPanelBody(panel, `<div class="fc-row fc-muted">Searching FleetCal…</div>`);
      const resp = await sendMsg({ type: "search", refs }).catch(() => ({ ok: false, error: "Extension was reloaded — refresh this Gmail tab." }));
      if (stale(sig)) return;
      const live = panelLive(sig);
      if (!live) return;
      if (resp && resp.ok && (resp.matches || []).some((m) => m.loads.length)) {
        await renderSearch(live, refs, resp, account, threadId);
        emailState = "found";
        return;
      }
    }

    // 4) Search any rate-con PDF that's loaded now; then keep watching (the
    //    one we want may be on a thread message that hasn't rendered yet).
    emailState = "open";
    const pdfsNow = detectPdfAttachments();
    if (pdfsNow.length) { await runPdfSearch(pdfsNow); return; }
    const liveF = panelLive(sig);
    if (liveF) renderNotFound(liveF, refs, account, threadId);
  }

  // Search the given (not-yet-tried) PDFs. Auto-links on a match; otherwise
  // leaves the email "open" so later-loading attachments still get checked.
  async function runPdfSearch(pdfs) {
    if (!ctx) return;
    const { sig, account, threadId, refs, subjectEl } = ctx;
    emailState = "searching";
    pdfs = pdfs.slice(0, 4);
    pdfs.forEach((p) => searchedPdfUrls.add(p.url));

    const live0 = panelLive(sig) || renderPanel(subjectEl, sig, refs || [], account, threadId);
    setPanelBody(live0, `<div class="fc-row fc-muted">Reading the rate con…</div>`);

    const pdfResp = await searchPdfs(pdfs);
    if (stale(sig)) return;
    const live = panelLive(sig);
    if (!live) { emailState = "open"; return; }

    if (pdfResp && pdfResp.ok && (pdfResp.matches || []).some((m) => m.loads.length)) {
      await renderSearch(live, pdfResp.refs || [], pdfResp, account, threadId);
      emailState = "found";
      return;
    }
    renderNotFound(live, (pdfResp && pdfResp.refs) || refs || [], account, threadId);
    emailState = "open"; // keep watching for more attachments
  }

  // Fetch + parse the first rate-con PDF that yields a result.
  // Try each attachment; return the FIRST that yields a match. If none match,
  // return the last valid response so the panel can show what was read. Caps
  // at 4 so a heavily-attached email can't fan out endlessly.
  async function searchPdfs(pdfs) {
    let last = null;
    for (const pdf of pdfs.slice(0, 4)) {
      try {
        const b64 = await fetchPdfBase64(pdf.url);
        const resp = await sendMsg({ type: "searchPdf", pdfBase64: b64 }).catch(() => null);
        if (resp) {
          last = resp;
          if (resp.ok && (resp.matches || []).some((m) => m.loads.length)) return resp;
        }
      } catch { /* try next attachment */ }
    }
    return last;
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
      if (btn.dataset.fc === "create") void doCreate(panel);
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
    // Show the broker's load number (what you'd recognize from the email),
    // falling back to the internal id only if there's no load number.
    return load.loadNum || (load.internalLoadId != null ? `#${load.internalLoadId}` : "load");
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

  const isExactMatch = (l) => !!l && (l.exact === true || l.matchExact === true);

  // Search results. An EXACT match (the load's own number/ref equals what we
  // searched) auto-links. A merely-fuzzy match — a substring or coincidental
  // id hit on an unrelated load — must NOT auto-link; we treat that as "not
  // confidently found" and surface it only as a manual suggestion.
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
    const exact = found.filter(({ load }) => isExactMatch(load));

    // No exact match → don't link anything. Show not-found + the loose
    // candidates (if any) as optional manual links, and the Create option.
    if (exact.length === 0) { renderNoExact(panel, refs, found, account, threadId); return; }

    // Auto-link the first exact match. The bot search collapses relay legs to
    // one row per load, so a single load = one entry.
    const primary = exact[0].load;
    if (account && threadId && primary.loadId) {
      await doLink(panel, account, threadId, primary.loadId, "auto");
      // doLink re-renders as ✓ Linked on success. Note any other distinct
      // loads referenced (exact first, then fuzzy) — as links, not auto-links.
      const others = [...exact.slice(1), ...found.filter(({ load }) => !isExactMatch(load))];
      if (others.length) {
        const extras = others.map(({ load }) => {
          const href = calendarHref(load);
          return href ? `<div class="fc-row fc-muted">also matched <a class="fc-link" href="${href}" target="_blank" rel="noopener">${escapeHtml(loadLabel(load))}</a></div>` : "";
        }).join("");
        if (extras) panel.querySelector(".fc-body")?.insertAdjacentHTML("beforeend", extras);
      }
      return;
    }

    // Can't link (no account/thread detected) — still show status, and hint
    // how to enable auto-linking. Only the exact matches count as "in system".
    const rows = exact.map(({ load, ref }) => {
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

  // Searched, but nothing's number actually matched (only loose/coincidental
  // hits, or no hits). This is almost always a genuinely new load — so the
  // primary action is Create. Any loose candidates are offered as one-click
  // manual links in case the right load is named differently in FleetCal.
  function renderNoExact(panel, refs, found, account, threadId) {
    const searched = refs.length ? `<div class="fc-row fc-muted">Searched: ${refs.map(escapeHtml).join(", ")}</div>` : "";
    let possible = "";
    if (found.length) {
      const rows = found.slice(0, 4).map(({ load, ref }) => {
        const label = escapeHtml(loadLabel(load));
        const via = ref ? `<span class="fc-via">via ${escapeHtml(ref)}</span>` : "";
        if (account && threadId && load.loadId) {
          return `<div class="fc-row fc-muted">maybe <button type="button" class="fc-btn-link" data-fc="link" data-loadid="${escapeHtml(load.loadId)}">${label}</button>${via}</div>`;
        }
        const href = calendarHref(load);
        const lk = href ? `<a class="fc-link" href="${href}" target="_blank" rel="noopener">${label}</a>` : label;
        return `<div class="fc-row fc-muted">maybe ${lk}${via}</div>`;
      }).join("");
      possible = `<div class="fc-row fc-muted">No exact match. Possible:</div>${rows}`;
    }
    const create = detectPdfAttachments().length
      ? `<div class="fc-row"><button type="button" class="fc-btn-go" data-fc="create">Create load from rate con →</button></div>`
      : "";
    const manual = (account && threadId)
      ? `<div class="fc-row"><input class="fc-manual-input" placeholder="link to load # / ref" />
           <button type="button" class="fc-btn-link" data-fc="manual">link existing</button></div>`
      : "";
    setPanelBody(panel,
      `<div class="fc-row fc-warn">⚠ Not in FleetCal</div>${searched}${possible}${create}${manual}`);
  }

  function renderNotFound(panel, refs, account, threadId) {
    const searched = refs.length ? `<div class="fc-row fc-muted">Searched: ${refs.map(escapeHtml).join(", ")}</div>` : "";
    // Offer to create the load from the rate-con PDF (opens the in-app
    // review flow on your FleetCal calendar tab).
    const create = detectPdfAttachments().length
      ? `<div class="fc-row"><button type="button" class="fc-btn-go" data-fc="create">Create load from rate con →</button></div>`
      : "";
    const manual = (account && threadId)
      ? `<div class="fc-row"><input class="fc-manual-input" placeholder="link to load # / ref" />
           <button type="button" class="fc-btn-link" data-fc="manual">link existing</button></div>`
      : "";
    setPanelBody(panel,
      `<div class="fc-row fc-warn">⚠ Not in FleetCal</div>${searched}${create}${manual}`);
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

  // Create a new load from the rate-con PDF: fetch it, hand it to the
  // FleetCal calendar tab, which runs the AI parse + opens the review modal.
  async function doCreate(panel) {
    const pdfs = detectPdfAttachments();
    if (!pdfs.length) { setPanelBody(panel, `<div class="fc-row fc-warn">No PDF attachment found.</div>`); return; }
    setPanelBody(panel, `<div class="fc-row fc-muted">Sending rate con to FleetCal…</div>`);
    try {
      const b64 = await fetchPdfBase64(pdfs[0].url);
      // Keep the real failure reason — don't collapse it to a generic message.
      const resp = await sendMsg({ type: "createLoad", pdfBase64: b64 })
        .catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
      if (resp && resp.ok) {
        const note = resp.reloading
          ? `<div class="fc-row fc-muted">Reloading your calendar to open the review…</div>`
          : `<div class="fc-row fc-muted">It links to this thread once saved (re-open this email to confirm).</div>`;
        setPanelBody(panel,
          `<div class="fc-row fc-ok">✓ Opened in FleetCal — review &amp; save.</div>${note}`);
      } else {
        let msg = (resp && resp.error) || "Couldn't start the load";
        // The usual cause: the extension was reloaded but a tab wasn't
        // refreshed, orphaning a content script.
        if (/context invalidated|establish connection|Receiving end|orphan/i.test(msg)) {
          msg = "Extension was reloaded — refresh this Gmail tab (and your FleetCal tab) and retry.";
        }
        setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(msg)}</div>`);
      }
    } catch (e) {
      setPanelBody(panel, `<div class="fc-row fc-warn">⚠ ${escapeHtml(String(e?.message || e))}</div>`);
    }
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
