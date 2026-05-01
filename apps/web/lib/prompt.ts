import { ALL_FIELDS } from './fields';

// Fields always extracted regardless of user settings (needed for the calendar event itself)
const ALWAYS_EXTRACT = ['summary', 'start', 'end'];

export interface PromptVariables {
  systemRole:  string;
  timezone:    string;
  titleFormat: string;
  notesFormat: string;
}

export const DEFAULT_PROMPT_VARIABLES: PromptVariables = {
  systemRole:  'You are parsing a trucking rate confirmation (rate con) document.',
  timezone:    'Mountain Time (America/Denver)',
  titleFormat: 'Broker name first, then short route — e.g. "Echo: Salt Lake City to Denver". If there are intermediate stops list all cities in order separated by →. Always lead with the broker name followed by a colon.',
  notesFormat: 'Driver-essential information only — anything important the driver needs that is NOT already captured in the structured fields (load number, reference numbers, stops, addresses, appointment times, special instructions). Include things like: detention policy, weight or temperature requirements, fuel surcharge details, equipment requirements (chains, straps, pallets), security or PPE requirements, TONU policy, after-hours / weekend access notes, and any unusual broker requirements. Keep it short and bulleted. Return an empty string if nothing essential remains beyond what other fields already capture.',
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

  // Enabled optional fields
  for (const field of ALL_FIELDS) {
    if (!enabledFieldIds.includes(field.id)) continue;
    if (ALWAYS_EXTRACT.includes(field.id)) continue;
    if (!field.extractionHint) continue;
    // notes field uses the user-configurable format variable — strip any "Special instructions" line
    // that may be persisted from older versions so it only appears in the dedicated field
    const rawHint = field.id === 'notes' ? variables.notesFormat : field.extractionHint;
    const hint = field.id === 'notes'
      ? rawHint.split('\n').filter(l => !/special instructions/i.test(l)).join('\n').trimEnd()
      : rawHint;
    schemaLines.push(`  "${field.id}": "${hint}"`);
  }

  const schema = `{\n${schemaLines.join(',\n')}\n}`;

  const customBlock = customInstructions.trim()
    ? `\nAdditional instructions:\n${customInstructions.trim()}\n`
    : '';

  const stopsSchema = `  "stops": [
    {
      "sequence": <integer starting at 1, in order of occurrence in the document>,
      "type": "<pickup | delivery | stop | drop_hook>",
      "facilityName": "<shipper/receiver/facility name, or empty string>",
      "address": "<full street address including city, state, zip — as complete as possible>",
      "city": "<just the city name, e.g. 'Spanish Fork' or 'Milford' — no state, no road, no zip>",
      "apptStart": "<appointment time or window start in YYYY-MM-DDTHH:mm (${variables.timezone}), or empty string>",
      "apptEnd": "<window end time in YYYY-MM-DDTHH:mm if a time window is given, otherwise empty string>",
      "instructions": "<any stop-specific instructions, notes, gate codes, or requirements listed on the rate con for this location, or empty string>"
    }
  ]`;

  return `${variables.systemRole} Extract every field you can find and return ONLY a valid JSON object — no markdown, no explanation.

Fill as many fields as possible. Use an empty string for any field not found — do not omit keys.

The "stops" array is REQUIRED. Extract every pickup, delivery, and intermediate stop in the order they appear in the document. For drop-and-hook stops use type "drop_hook". If a stop is both a pickup and delivery at the same location, create two entries.

${schema},
${stopsSchema}
${customBlock}
Convert all times to ${variables.timezone}.`;
}
