-- 20260803_payroll_paystub_delivery.sql
--
-- "Send paystub" delivery state on payroll_records.
--
-- WHY
-- ---
-- Finalizing a week already freezes the numbers (line_items + total_pay,
-- append-only per 20260728_payroll_records_snapshot). That was the hard
-- part of "the number the driver saw can't change after send." What was
-- missing was a way to actually TELL the driver, and to remember that
-- we did.
--
-- Delivery state lives on the payroll_records row rather than in a
-- separate paystub_deliveries table because a snapshot is the paystub —
-- there is nothing to deliver that isn't already frozen there. Splitting
-- would just add a join to every read.
--
-- COLUMNS
-- -------
-- view_token         — random ~22-char base32 string, unique per record.
--                      Included in the SMS link (/paystub/<token>). Serves
--                      as the auth: possession of the token = access, no
--                      Clerk login required (drivers don't have web
--                      accounts). Rotates on re-finalize because a new
--                      record row is inserted, so a leaked or old token
--                      naturally goes stale.
--
-- sent_at            — first successful send (either channel). Null while
--                      the paystub has never been delivered.
--
-- sent_via           — text[] of channels that succeeded on the latest
--                      send. Values today: 'sms', 'push'. A resend
--                      overwrites the array so the array always describes
--                      the MOST RECENT attempt's outcome.
--
-- sms_message_sid    — Twilio message SID returned on a successful SMS
--                      send. Kept for support tickets (Twilio's console
--                      is the source of truth for delivery status).
--
-- send_error         — one-line error captured on failed send so the UI
--                      can show why a "Send" click didn't land, without
--                      the dispatcher having to open Railway logs.
--
-- viewed_at          — first time the driver opened the link (page load
--                      on /paystub/<token> or GET on the public endpoint).
--                      Used by the payroll UI to show a "Viewed" chip so
--                      dispatchers know the driver actually saw it.
--
-- Only the ACTIVE (non-superseded) row is ever mutated. Superseded rows
-- keep whatever delivery state they had at the moment they were
-- superseded — that's the historical record of "this is what was sent
-- to the driver at the time." Re-finalizing generates a fresh row with
-- delivery state cleared, so a corrected paystub needs its own send.

alter table payroll_records
  add column if not exists view_token       text,
  add column if not exists sent_at          timestamptz,
  add column if not exists sent_via         text[] not null default '{}',
  add column if not exists sms_message_sid  text,
  add column if not exists send_error       text,
  add column if not exists viewed_at        timestamptz;

-- Tokens are the paystub's URL — must be unique. Partial index because
-- rows finalized before this migration have no token and shouldn't
-- collide. The generator (in the API's send endpoint) uses ~22 base32
-- chars = ~110 bits of entropy, so collision risk is negligible.
create unique index if not exists payroll_records_view_token_uniq
  on payroll_records (view_token)
  where view_token is not null;

-- The public paystub endpoint looks records up BY token. Same partial
-- index above serves that lookup too — no extra index needed.

notify pgrst, 'reload schema';
