import { ALL_FIELDS } from './fields';

// Fields always extracted regardless of user settings.
//
// `summary` / `start` / `end` — needed for the calendar event itself.
//
// `commodity` / `weight` — Curzon has these hidden on the load modal
// (they care about price + stops, not what's on the trailer), but
// other carriers run reefer / flatbed / hazmat ops where commodity +
// weight are first-class. Pulling them every time means a carrier
// who later re-enables either field gets backfill for free on past
// loads (the value is saved on the load row whether or not the UI
// shows it), and other orgs see autofill on day one. Skipping
// extraction just because the dispatcher who parsed the rate-con
// happens to be Curzon would silently throw away a field the org
// might want later.
const ALWAYS_EXTRACT = ['summary', 'start', 'end', 'commodity', 'weight'];

export interface PromptVariables {
  systemRole:  string;
  timezone:    string;
  titleFormat: string;
  specialInstructionsFormat: string;
}

export const DEFAULT_PROMPT_VARIABLES: PromptVariables = {
  systemRole:  'You are parsing a trucking rate confirmation (rate con) document.',
  timezone:    'Mountain Time (America/Denver)',
  titleFormat: 'Customer name first, then short route — e.g. "Echo: Salt Lake City to Denver". If there are intermediate stops list all cities in order separated by →. Always lead with the customer name followed by a colon.',
  specialInstructionsFormat: 'Driver-essential customer requirements only. Do NOT repeat stop addresses, appointment times, gate-arrival windows, or anything that belongs on a specific stop — those are already captured in the structured stops array. Focus on load-level info that applies across the whole load: detention policy, weight or temperature requirements, equipment requirements (chains, straps, pallets), security or PPE requirements, TONU policy, after-hours / weekend access notes, lumper/dock fees, and any unusual customer requirements. Exclude insurance terms, payment terms, and customer/carrier legal language. Keep it short and bulleted. Return an empty string if nothing essential remains beyond what other fields already capture.',
};

/**
 * Pass-2 corrective prompt. Fires only when pass-1's output fails the
 * date cross-check (stops[0].apptStart !== start, stops[last].apptStart
 * !== end, or a middle stop falls outside the window). Sonnet gets the
 * failed JSON, the specific discrepancies, AND pass-1's own citations
 * for where it claimed to find each date — so it has explicit context
 * for what to re-read instead of starting from scratch.
 *
 * Returns ONLY the corrected date fields, not the full schema — the
 * route merges these back into the original parsed object so we don't
 * lose the other fields pass-1 got right.
 */
export function buildRateConCorrectivePrompt(
  failedOutput: Record<string, unknown>,
  discrepancies: string[],
  variables: PromptVariables = DEFAULT_PROMPT_VARIABLES,
): string {
  const stripped = {
    start: failedOutput.start,
    end:   failedOutput.end,
    stops: Array.isArray(failedOutput.stops)
      ? (failedOutput.stops as Array<Record<string, unknown>>).map(s => ({
          sequence:  s.sequence,
          type:      s.type,
          facilityName: s.facilityName,
          apptStart: s.apptStart,
          apptEnd:   s.apptEnd,
        }))
      : [],
    dateJustifications: failedOutput.dateJustifications,
  };

  return `${variables.systemRole}

A first-pass extraction (Haiku) returned dates that violate the rate-con's internal consistency. Your job: re-read the PDF and return corrected dates. The previous pass cited where it claimed to find each date — use those citations as starting points, but verify against the actual PDF, not the citations alone.

PREVIOUS EXTRACTION (showing only the date fields + the model's own citations):
${JSON.stringify(stripped, null, 2)}

DISCREPANCIES THAT MUST BE FIXED:
${discrepancies.map(d => `- ${d}`).join('\n')}

GROUND TRUTH RULES:
- The load's "start" field is the FIRST stop's appointment time. They MUST be the same datetime, to the minute.
- The load's "end" field is the LAST stop's appointment time. They MUST be the same datetime, to the minute.
- Every middle stop's appointment time MUST fall within [start, end] inclusive.
- IGNORE non-appointment dates: issue date, signature date, tendered date, ready-by, available-by, payment terms, insurance certs.

Return ONLY a JSON object with the corrected date fields — no markdown, no explanation:

{
  "start": "<copy from stops[0].apptStart EXACTLY — same naive YYYY-MM-DDTHH:mm string, no tz conversion>",
  "end":   "<copy from stops[last].apptStart EXACTLY — same naive YYYY-MM-DDTHH:mm string, no tz conversion>",
  "stops": [
    { "sequence": <integer matching the original>, "apptStart": "<corrected, in this stop's local time>", "apptEnd": "<corrected or empty>" }
  ]
}

Times are LOCAL to each stop. If the rate con prints "15:00 PDT" at a Vegas pickup, output "2026-06-02T15:00" — do not convert. The downstream system tags each stop with the correct tz from geocoding.

Include every stop from the original output, in the same sequence order. Do not add or remove stops.`;
}

export function buildRateConPrompt(
  enabledFieldIds: string[],
  customInstructions: string,
  variables: PromptVariables = DEFAULT_PROMPT_VARIABLES,
): string {
  const alwaysSchema: Record<string, string> = {
    summary: variables.titleFormat,
    start:   `First pickup date/time in YYYY-MM-DDTHH:mm (24-hour, LOCAL to the first stop — copy literally from the rate con, do not convert tz)`,
    end:     `Final delivery date/time in YYYY-MM-DDTHH:mm (24-hour, LOCAL to the last stop — copy literally from the rate con, do not convert tz)`,
  };

  const schemaLines: string[] = [];

  // Always-present fields. For summary/start/end the hint lives in
  // `alwaysSchema` above (they bake in titleFormat / timezone). For
  // every other always-extract field (commodity, weight, …) we fall
  // through to the ALL_FIELDS entry's extractionHint — that way one
  // place owns the field description and the always-extract list is
  // just a set of ids to force through regardless of org settings.
  for (const id of ALWAYS_EXTRACT) {
    const hint =
      alwaysSchema[id]
      ?? ALL_FIELDS.find(f => f.id === id)?.extractionHint;
    if (!hint) continue;
    schemaLines.push(`  "${id}": "${hint}"`);
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
      "apptStart": "<appointment time or window start in YYYY-MM-DDTHH:mm — LOCAL to THIS stop's clock. If rate con prints '15:00 PDT' at a Vegas stop, output '2026-06-02T15:00'. If it prints '10:00 MDT' at a Draper UT stop, output '2026-06-03T10:00'. NEVER cross-convert between stops. Empty string if no time given.>",
      "apptEnd": "<window end time in YYYY-MM-DDTHH:mm if a time window is given (same LOCAL-to-this-stop rule as apptStart), otherwise empty string>",
      "instructions": "<any stop-specific instructions, notes, gate codes, or requirements listed on the rate con for this location, or empty string>"
    }
  ],
  "dateJustifications": {
    "start":   "<short citation of WHERE on the PDF you found the load start datetime — quote the exact text or describe the section, e.g. \\"Pickup #1 row: 06/10/2026 23:00 - 06/10/2026 23:59\\" or \\"Top of page 2, Appointment field under origin\\". Keep under 120 chars.>",
    "end":     "<same shape, but for the load end datetime>",
    "stops": [
      { "sequence": <matches stop sequence>, "apptStart": "<short citation for this stop's apptStart>", "apptEnd": "<citation for apptEnd, or empty string>" }
    ]
  }`;

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
${customBlock}
TIMES ARE LOCAL TO EACH STOP. Copy times LITERALLY as printed at each stop — do NOT cross-convert between stops, even when the document lists timezone labels like "PDT" or "MDT". A Vegas stop printed "15:00 PDT" outputs "2026-06-02T15:00". A Draper UT stop printed "10:00 MDT" on the same load outputs "2026-06-03T10:00". The downstream system pins each stop to its own timezone from geocoding, so cross-converting here would double-shift the appointment.

The HARD CONSTRAINTS in section 4 above (stops[0].apptStart === start, stops[last].apptStart === end) compare the raw string values — they are still satisfied because each end of the load reads the literal time at its own stop.`;
}
