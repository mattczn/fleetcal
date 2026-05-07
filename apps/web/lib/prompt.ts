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
  mcNum?:               string;
  contactName?:         string;
  contactEmail?:        string;
  contactPhone?:        string;
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
    "mcNum":               "<broker MC number if listed, digits only>",
    "contactName":         "<dispatcher or rep name on the rate con>",
    "contactEmail":        "<dispatcher / billing email>",
    "contactPhone":        "<dispatcher phone, digits + format as on the doc>",
    "invoiceInstructions": "<short summary of how to bill this broker — portal name + URL, AP email, required documents (BOL/POD/scale ticket), payment terms (net 30, quickpay), factor preferences, anything else billing-relevant. Combine into 2-5 short bulleted lines.>"
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

${schema},
${stopsSchema}
${customBlock}${brokerRulesBlock}
Convert all times to ${variables.timezone}.`;
}
