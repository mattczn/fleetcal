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

export function buildRateConPrompt(
  enabledFieldIds: string[],
  customInstructions: string,
  variables: PromptVariables = DEFAULT_PROMPT_VARIABLES,
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
${customBlock}
Convert all times to ${variables.timezone}.`;
}
