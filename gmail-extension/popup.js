const $ = (id) => document.getElementById(id);
const FIELDS = ["apiBase", "botKey", "appBase", "labelName", "gmailAccount"];

const DEFAULTS = {
  apiBase:   "https://fleetcalapi-production.up.railway.app",
  appBase:   "https://fleetcal.app",
  labelName: "New Load",
};

chrome.storage.sync.get(FIELDS, (cfg) => {
  for (const f of FIELDS) $(f).value = cfg[f] ?? DEFAULTS[f] ?? "";
});

$("save").addEventListener("click", () => {
  const out = {};
  for (const f of FIELDS) out[f] = $(f).value.trim();
  chrome.storage.sync.set(out, () => {
    $("status").textContent = "Saved";
    setTimeout(() => ($("status").textContent = ""), 1500);
  });
});
