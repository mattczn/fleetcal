const $ = (id) => document.getElementById(id);
const FIELDS = ["apiBase", "botKey", "appBase", "labelName", "gmailAccount"];
/** Checkbox rather than text — handled separately from FIELDS. */
const TOGGLES = ["autoExpand"];

const DEFAULTS = {
  apiBase:   "https://fleetcalapi-production.up.railway.app",
  appBase:   "https://fleetcal.app",
  labelName: "New Load",
};

chrome.storage.sync.get([...FIELDS, ...TOGGLES], (cfg) => {
  for (const f of FIELDS) $(f).value = cfg[f] ?? DEFAULTS[f] ?? "";
  // Defaults to false: auto-expanding a thread marks its buried unread
  // messages as read, which quietly empties a billing mailbox's queue.
  for (const t of TOGGLES) $(t).checked = cfg[t] === true;
});

$("save").addEventListener("click", () => {
  const out = {};
  for (const f of FIELDS) out[f] = $(f).value.trim();
  for (const t of TOGGLES) out[t] = $(t).checked;
  chrome.storage.sync.set(out, () => {
    $("status").textContent = "Saved";
    setTimeout(() => ($("status").textContent = ""), 1500);
  });
});
