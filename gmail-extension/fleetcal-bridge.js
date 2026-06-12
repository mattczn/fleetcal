// fleetcal-bridge.js — runs on FleetCal app pages.
//
// Relays an "open this event" request from the extension background into the
// page via window.postMessage. The FleetCal calendar listens for it
// (CalendarDeepLink) and opens the event in-place — no full page reload.
//
// The background only sends this when the tab is already on /calendar; from
// any other page it navigates normally.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "openEvent" && msg.eventId) {
    window.postMessage(
      { source: "fleetcal-ext", type: "openEvent", eventId: msg.eventId, date: msg.date || null },
      window.location.origin
    );
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "createFromPdf" && msg.pdfBase64) {
    window.postMessage(
      { source: "fleetcal-ext", type: "createFromPdf", pdfBase64: msg.pdfBase64 },
      window.location.origin
    );
    sendResponse({ ok: true });
    return false;
  }
  if (msg && msg.type === "createFromPdfs" && Array.isArray(msg.pdfList)) {
    window.postMessage(
      { source: "fleetcal-ext", type: "createFromPdfs", pdfList: msg.pdfList },
      window.location.origin
    );
    sendResponse({ ok: true });
    return false;
  }
  return false;
});

// On a freshly-opened calendar page, deliver rate con(s) staged by the
// background (the "Create load" flow when no calendar tab was open, or a
// self-heal reload). Poll-post until the app acks, since the React listener
// may mount after this script runs. Only on /calendar — other FleetCal pages
// ignore it. Clears the stage on ack. Supports a list (multi-rate-con) and a
// single PDF (older stage).
(function deliverPendingCreate() {
  if (!location.pathname.startsWith("/calendar")) return;
  chrome.storage.local.get(["pendingCreatePdfs", "pendingCreatePdf"], (res) => {
    const multi  = res && res.pendingCreatePdfs;
    const single = res && res.pendingCreatePdf;
    const stage  = (multi && Array.isArray(multi.list) && multi.list.length) ? multi : single;
    if (!stage) return;
    const key  = (stage === multi) ? "pendingCreatePdfs" : "pendingCreatePdf";
    const list = (stage === multi) ? multi.list : (single.pdfBase64 ? [single.pdfBase64] : []);
    if (!list.length) { chrome.storage.local.remove(key); return; }
    if (Date.now() - (stage.ts || 0) > 60000) { chrome.storage.local.remove(key); return; }

    const post = () => window.postMessage(
      { source: "fleetcal-ext", type: "createFromPdfs", pdfList: list }, window.location.origin);

    let acked = false, tries = 0;
    function onAck(e) {
      if (e.source !== window || !e.data || e.data.source !== "fleetcal-ext-app" || e.data.type !== "createAck") return;
      acked = true;
      window.removeEventListener("message", onAck);
      chrome.storage.local.remove(key);
    }
    window.addEventListener("message", onAck);
    const timer = setInterval(() => {
      if (acked || tries++ > 30) {                 // ~21s max
        clearInterval(timer);
        if (!acked) window.removeEventListener("message", onAck);
        return;
      }
      post();
    }, 700);
  });
})();
