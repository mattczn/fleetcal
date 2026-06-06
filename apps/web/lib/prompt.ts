import { ALL_FIELDS } from './fields';

// Fields always extracted regardless of user settings (needed for the calendar event itself)
const ALWAYS_EXTRACT = ['summary', 'start', 'end'];

export interface PromptVariables {
  systemRole:  string;
  timezone:    string;
  titleFormat: string;
  specialInstructionsFormat: string;
}

export const DEFAULT_PROMPT_VARIABLES: PromptVariables = {
  systemRole:  'You are parsing a trucking rate confirmation (rate con) document.',
  timezone:    'Mountain Time (America/Denver)',
  titleFormat: 'Broker name first, then short route — e.g. "Echo: Salt Lake City to Denver". If there are intermediate stops list all cities in order separated by →. Always lead with the broker name followed by a colon.',
  specialInstructionsFormat: 'Driver-essential broker requirements only. Do NOT repeat stop addresses, appointment times, gate-arrival windows, or anything that belongs on a specific stop — those are already captured in the structured stops array. Focus on load-level info that applies across the whole load: detention policy, weight or temperature requirements, equipment requirements (chains, straps, pallets), security or PPE requirements, TONU policy, after-hours / weekend access notes, lumper/dock fees, and any unusual broker requirements. Exclude insurance terms, payment terms, and broker/carrier legal language. Keep it short and bulleted. Return an empty string if nothing essential remains beyond what other fields already capture.',
};

export interface BrokerRule {
  name:    string;     // canonical name
  aliases: string[];   // additional names the broker may appear as
  hints:   string;     // free-form guidance from the org's customer record
}

/** Pass-1 harvest result. Used to look up matching customer record and
 *  to pre-fill a new one if no match. All fields optional — Claude
 *  returns "" when something isn't on the document. */
export interface BrokerProfile {
  name?:                string;
  contactName?:         string;
  contactEmail?:        string;
  contactPhone?:        string;
  /** "email" | "portal" — how this broker accepts invoices. */
  invoiceMethod?:       string;
  /** AP / billing email when invoiceMethod is "email". */
  invoiceEmail?:        string;
  /** Portal name + URL when invoiceMethod is "portal". */
  invoicePortal?:       string;
  /** Catch-all for additional broker-wide billing notes (terms,
   *  required docs, factor). Must NOT include load-specific
   *  identifiers (load #, PRO #, this load's PO/reference, etc.) —
   *  those would pollute future invoices for the same broker. The
   *  prompt enforces this explicitly. */
  invoiceInstructions?: string;
  /** "rate_con" | "amendment" | "revised" | "other" — quick sanity check;
   *  if "other" the caller may bail out before pass 2. */
  docType?:             string;
}

/**
 * Pass-1 prompt: identify the broker and harvest a few fields that
 * belong on the customer record. Output is small (~150 tokens) so the
 * subsequent full-schema pass can run cheaply against the cached PDF.
 */
export function buildBrokerHarvestPrompt(timezone: string): string {
  return `You are the first of a two-pass rate-confirmation parser. This pass extracts ONLY the broker/customer profile so the second pass can apply broker-specific rules.

Return a single JSON object with this exact shape — no markdown, no explanation. Use empty strings for fields not on the document; do not omit keys.

{
  "broker": {
    "name":                "<canonical broker / customer / shipper company name as it appears>",
    "contactName":         "<dispatcher or rep name on the rate con>",
    "contactEmail":        "<dispatcher / billing contact email>",
    "contactPhone":        "<dispatcher phone, digits + format as on the doc>",
    "invoiceMethod":       "<'email' | 'portal' | '' — how this broker wants invoices submitted. 'portal' if any online billing system is named (TriumphPay, RMIS, McLeod, MyCarrierPortal, broker's own portal, etc.). 'email' if invoices go to a specific AP/billing email. Empty string if unclear.>",
    "invoiceEmail":        "<AP / billing email when invoiceMethod is 'email', otherwise empty string>",
    "invoicePortal":       "<portal name + URL when invoiceMethod is 'portal', e.g. 'TriumphPay (https://app.triumphpay.com)'. Otherwise empty string.>",
    "invoiceInstructions": "<BROKER-WIDE billing policies only — things that apply to EVERY load from this broker, not just this one. Allowed: payment terms (net 30, quickpay rates), required documents that are always needed (BOL/POD/scale tickets/lumper receipts), factor preferences, remit-to address overrides, billing portal requirements, required line items the broker wants on every invoice. 1-3 short bulleted lines. STRICTLY EXCLUDE anything load-specific: this load's load number, PRO number, BOL number, PO number, shipment/order/confirmation number, references to 'this load' or 'this shipment', or any value that would change on the next load from the same broker. Empty string if there's nothing broker-wide to add.>"
  },
  "docType": "<rate_con | amendment | revised | other>"
}

The current timezone is ${timezone}.`;
}

export function buildRateConPrompt(
  enabledFieldIds: string[],
  customInstructions: string,
  variables: PromptVariables = DEFAULT_PROMPT_VARIABLES,
  brokerRules: BrokerRule[] = [],
): string {
  const alwaysSchema: Record<string, string> = {
    summary: variables.titleFormat,
    start:   `First pickup date/time in YYYY-MM-DDTHH:mm (24-hour, ${variables.timezone})`,
    end:     `Final delivery date/time in YYYY-MM-DDTHH:mm (24-hour, ${variables.timezone})`,
  };

  const schemaLines: string[] = [];

  // Always-present fields
  for (const id of ALWAYS_EXTRACT) {
    schemaLines.push(`  "${id}": "${alwaysSchema[id]}"`);
  }

  // Enabled optional fields. specialInstructions uses the user-customizable variable.
  for (const field of ALL_FIELDS) {
    if (!enabledFieldIds.includes(field.id)) continue;
    if (ALWAYS_EXTRACT.includes(field.id)) continue;
    if (!field.extractionHint) continue;
    const hint = field.id === 'specialInstructions'
      ? variables.specialInstructionsFormat
      : field.extractionHint;
    schemaLines.push(`  "${field.id}": "${hint}"`);
  }

  const schema = `{\n${schemaLines.join(',\n')}\n}`;

  const customBlock = customInstructions.trim()
    ? `\nAdditional instructions:\n${customInstructions.trim()}\n`
    : '';

  // Per-broker rules — pulled from the org's customer records. Each rule
  // applies only when the rate-con's broker name (or an alias) matches.
  // Skipped entirely when no customers have parse hints set.
  const brokerRulesBlock = brokerRules.length > 0
    ? `\nPer-broker rules — apply the matching rule when the rate-con's broker name (or any alias) matches a name below:\n${brokerRules
        .map(r => {
          const aliasPart = r.aliases.length > 0 ? ` (aliases: ${r.aliases.join(', ')})` : '';
          return `- ${r.name}${aliasPart}: ${r.hints.trim()}`;
        })
        .join('\n')}\n`
    : '';

  const stopsSchema = `  "stops": [
    {
      "sequence": <integer starting at 1, in order of occurrence in the document>,
      "type": "<pickup | delivery | drop | drop_hook | stop>",
      "facilityName": "<shipper/receiver/facility name, or empty string>",
      "address": "<full street address including city, state, zip — as complete as possible>",
      "city": "<just the city name, e.g. 'Spanish Fork' or 'Milford' — no state, no road, no zip>",
      "scheduleType": "<appointment | window | fcfs — pick 'appointment' if a single time, 'window' if a time range, 'fcfs' if 'first come first served' or no fixed time. Empty string if unclear.>",
      "apptStart": "<appointment time or window start in YYYY-MM-DDTHH:mm (${variables.timezone}), or empty string>",
      "apptEnd": "<window end time in YYYY-MM-DDTHH:mm if a time window is given, otherwise empty string>",
      "instructions": "<any stop-specific instructions, notes, gate codes, or requirements listed on the rate con for this location, or empty string>"
    }
  ]`;

  return `${variables.systemRole} Extract every field you can find and return ONLY a valid JSON object — no markdown, no explanation.

Fill as many fields as possible. Use an empty string for any field not found — do not omit keys.

The "stops" array is REQUIRED. Extract every pickup, delivery, and intermediate stop in the order they appear in the document. Stop type rules: "pickup" = live load (driver waits), "delivery" = live unload, "drop" = drop loaded trailer (no hook of another), "drop_hook" = drop loaded AND hook empty/different, "stop" = intermediate non-loading stop. If a stop is both a pickup and delivery at the same location, create two entries.

DATE EXTRACTION — read this section TWICE before extracting any date:

The load's "start" is the FIRST stop's appointment time. The load's "end" is the LAST stop's appointment time. The first stop and the load start are the SAME EVENT — they MUST share the same date and time.

1. Copy dates LITERALLY. Do NOT compute, infer, shift, or "add business days". If the rate con says "06/04/2026", write "2026-06-04".

2. IGNORE these dates — they are NOT appointment times:
   - Load-confirmation date / issue date / signature date / "tendered" date / "created" date
   - "Available by" / "ready by" / "must deliver by" dates UNLESS that's the only date given for a stop
   - Payment terms ("net 30", "due in 30 days")
   - Insurance certificate effective / expiration dates
   - Broker contract / agreement dates
   - Any date printed in a header, footer, or signature block

3. ONLY use dates that are explicitly tied to a stop — printed in the stop's appointment column, or directly next to the stop's address, or labeled "Appointment", "Pickup", "Delivery", "Stop", "PU", "DEL", "SO".

4. HARD CONSTRAINTS — every value you return MUST satisfy ALL of these:
   - stops[0].apptStart === start (exact same date AND time, to the minute)
   - stops[last].apptStart === end (exact same date AND time, to the minute)
   - For every middle stop: start <= stops[i].apptStart <= end (inclusive of both ends)

5. Self-check before returning. Walk through your stops array and verify constraint #4. If any stop violates it, you misread the document — go back to the appointment column for that stop and re-extract. Do NOT return JSON that violates these constraints; that would be a bug.

${schema},
${stopsSchema}
${customBlock}${brokerRulesBlock}
Convert all times to ${variables.timezone}.`;
}
