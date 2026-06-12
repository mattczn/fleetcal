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
  return false;
});
