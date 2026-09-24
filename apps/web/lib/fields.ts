export type FieldSection = 'load' | 'locations' | 'financial' | 'notes';

export interface FieldDef {
  id: string;
  label: string;
  section: FieldSection;
  type: 'text' | 'number' | 'boolean' | 'select' | 'textarea';
  defaultEnabled: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  extractionHint?: string;
  span?: boolean; // force full-width (never pair with another field)
}

export const SECTION_LABELS: Record<FieldSection, string> = {
  load:      'Load Info',
  locations: 'Locations',
  financial: 'Financial',
  notes:     'Notes',
};

export const DEFAULT_SECTION_ORDER: FieldSection[] = ['load', 'locations', 'financial', 'notes'];

export const ALL_FIELDS: FieldDef[] = [
  // Load Info — loadNum+refNums paired, trailerType+trailer paired, broker+dispatcher paired
  { id: 'loadNum',    label: 'Load #',            section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: '10421',            extractionHint: 'Load or order number assigned by the customer (broker or shipper)' },
  { id: 'refNums',    label: 'Reference #s',      section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'REF-001, REF-002', extractionHint: 'Reference numbers as a JSON array of objects with label and value keys, e.g. [{"label":"Pickup #","value":"12345"},{"label":"BOL","value":"99001"}]. Include PO #, PRO #, BOL, order ID, confirmation #. Do NOT include MC numbers, DOT numbers, or carrier identification numbers. Omit any entry where the value is blank, N/A, unknown, or a dash. Return [] if none found.' },
  { id: 'trailerType',label: 'Equipment Type',    section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'Dry Van, Reefer, Flatbed…', extractionHint: 'Trailer / equipment type required, e.g. Dry Van, Reefer, Flatbed, Step Deck' },
  { id: 'trailer',    label: 'Trailer',           section: 'load',      type: 'select', defaultEnabled: true  },
  { id: 'broker',     label: 'Customer',          section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'XYZ Logistics',    extractionHint: 'Customer company name (broker or direct shipper)' },
  { id: 'dispatcher', label: 'Dispatcher',        section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'John Smith' },
  { id: 'commodity',  label: 'Commodity',         section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'Frozen produce, Industrial parts…', extractionHint: 'What is being hauled. Free text from the rate con (e.g. "Frozen blueberries", "Auto parts", "General freight"). If reefer, prepend the temperature setpoint or range. Omit if not stated.' },
  { id: 'weight',     label: 'Weight (lbs)',      section: 'load',      type: 'number', defaultEnabled: true,  placeholder: '40000',            extractionHint: 'Total cargo weight in pounds — number only, no commas or units. Convert from kg/tons if needed. Omit if not stated.' },

  // Financial
  // The TOTAL agreed rate, not the linehaul line. A rate con that
  // itemises ("LineHaul $3,099.15 / Fuel Surcharge $800.85 / Total
  // $3,900.00") used to yield 3099.15, because this hint said "BEFORE
  // accessorials" and the model dutifully picked the line labelled
  // LineHaul. Nothing else captures the fuel surcharge — the parser
  // doesn't extract accessorials — so that $800.85 was simply dropped
  // and the load billed short.
  { id: 'loadPrice',     label: 'Linehaul ($)',       section: 'financial', type: 'number', defaultEnabled: true,  placeholder: '0.00',    extractionHint: 'TOTAL agreed rate the broker pays for this load — the grand total, INCLUDING fuel surcharge, mileage surcharge, tracking/ELD bonus, stop-off pay, tarp, hazmat, and any other charge already agreed on the rate con. If the rate con prints a "Total" / "Total Rate" / "Total Charges" line, use that figure EXACTLY. If it itemises without a total (e.g. LineHaul + Fuel Surcharge), add the agreed lines together. Do NOT use a line labelled "Linehaul"/"Line Haul" on its own when other agreed charges are listed. EXCLUDE conditional charges that have not been earned — detention, layover, lumper, TONU and anything worded "if applicable" or "per hour after N hours"; those are billed later as accessorials. Number only, no $ sign or commas, e.g. 3900.00' },
  { id: 'driverPay',     label: 'Driver Pay ($)',     section: 'financial', type: 'number', defaultEnabled: true,  placeholder: '0.00' },

  // Special Instructions — extraction hint is overridden by promptVariables.specialInstructionsFormat
  { id: 'specialInstructions', label: 'Special Instructions', section: 'notes', type: 'textarea', defaultEnabled: true, placeholder: 'Driver must check in at gate B…', extractionHint: 'Driver-essential customer requirements only — see prompt variable for full guidance.' },
];

/**
 * Initial fieldSettings for an org that has nothing saved on the
 * server yet (new sign-up, or local-state fallback before hydration).
 *
 * Policy: every field is ON by default. A new carrier gets the
 * widest possible load modal so they can see everything FleetCal
 * tracks; they can hide fields they don't need from Settings →
 * Appearance → Load Modal. This matches the per-field
 * `defaultEnabled: true` flags, but we force the value here too so a
 * future field accidentally added with `defaultEnabled: false`
 * doesn't silently ship a smaller modal to new orgs — that's a
 * surprise we don't want.
 */
export function buildDefaultFieldSettings(): Record<string, boolean> {
  return Object.fromEntries(ALL_FIELDS.map(f => [f.id, true]));
}

export function getEnabledFieldsForSection(
  section: FieldSection,
  fieldSettings: Record<string, boolean>,
): FieldDef[] {
  return ALL_FIELDS.filter(f => f.section === section && fieldSettings[f.id]);
}
