# FleetCal Load Reconciliation (Gmail extension)

A Manifest V3 Chrome extension. When you **open** a Gmail email carrying your
**"New Load"** label, it pulls the reference / load numbers out of the subject
and body, asks your FleetCal API whether any of them are already a load, and
shows a panel at the top of the email:

- **✓ In system** — with a link straight to the load in FleetCal, or
- **⚠ Not in FleetCal** — listing the refs it searched.

It talks **only** to your own FleetCal API (the bot endpoint), using your bot
key. No Google OAuth, no Gmail API scope — it reads the email straight from the
page you already have open.

---

## Install (load unpacked)

1. Go to `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. **Load unpacked** → select this `gmail-extension/` folder
4. Click the extension icon and fill in:
   - **API base URL** — `https://fleetcalapi-production.up.railway.app`
   - **Bot API key** — your FleetCal `BOT_API_KEY` (the `x-bot-key` value)
   - **FleetCal app URL** — `https://fleetcal.app`
   - **Gmail label** — `New Load`
5. Open a labeled email in Gmail. The panel appears at the top.

---

## How it works

```
content.js  (in the Gmail tab)         background.js (service worker)
  open "New Load" email                   reads bot key from storage
  → extract refs from subject+body        → GET /v1/bot/loads/search?q=<ref>
  → sendMessage({type:"search", refs}) ─▶    x-bot-key: <key>   (per ref)
  ← matches ◀──────────────────────────  ← { loads: [...] }
  → render panel
```

The API call runs in the **background worker**, not the content script. Two
reasons: (1) a content-script fetch carries `Origin: https://mail.google.com`,
which the FleetCal API's CORS allow-list rejects — the worker, granted
`host_permissions` for the API domain, isn't subject to that; (2) the bot key
stays out of the page's JS world.

The search hits `GET /v1/bot/loads/search`, which matches `load_num`,
`internal_load_id`, `broker`, **and** `ref_nums` (the broker's reference
numbers) — so the refs lifted from the email line up with what FleetCal stores.

> Note: the bot endpoint is scoped to a single org via `BOT_ORG_ID` on the
> server, so this checks against that org's loads. That's the intended setup
> for your own use.

---

## Reference extraction

Two passes over `subject + body`:
1. **Labelled** tokens — text after `load`, `ref`, `reference`, `pro`, `order`,
   `bol`, `shipment`, `confirmation`, `po`, `pickup`, etc.
2. **Standalone** id-looking tokens — `[A-Z]{0,4}-?\d{5,12}`.

Deduped, upper-cased, capped at 10 per email. It's deliberately permissive: a
token that isn't really a load number just returns no match, so over-capturing
is harmless. Tune `LABELLED` / `STANDALONE` / `MAX_REFS` in `content.js` if your
brokers use an unusual format.

---

## Tuning the Gmail selectors (if detection breaks)

Gmail obfuscates class names and shifts them across versions. Two constants at
the top of `content.js`:

- `SUBJECT_SELECTOR` (default `h2.hP`) — the open email's subject
- `BODY_SELECTOR` (default `.a3s`) — a message body block

Label detection is text-based (`emailHasLabel`) and walks up from the subject,
so it usually works once the **Gmail label** field matches your label exactly.

To find the right values on your inbox, open an email, open DevTools console:

```js
document.querySelector("h2.hP")?.textContent;       // subject present?
document.querySelectorAll(".a3s").length;            // body blocks present?
```

---

## Roadmap (next)

**Create from attachment.** When a load isn't found, grab the rate-con PDF
attachment and open FleetCal's existing "new load from rate-con" page with it,
so you review + save in the real app (AI-parse + human review). Not in this
version — this one is read-only reconciliation.
