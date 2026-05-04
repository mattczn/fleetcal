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
  { id: 'loadNum',    label: 'Load #',            section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: '10421',            extractionHint: 'Load or order number assigned by the broker or shipper' },
  { id: 'refNums',    label: 'Reference #s',      section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'REF-001, REF-002', extractionHint: 'Reference numbers as a JSON array of objects with label and value keys, e.g. [{"label":"Pickup #","value":"12345"},{"label":"BOL","value":"99001"}]. Include PO #, PRO #, BOL, order ID, confirmation #. Do NOT include MC numbers, DOT numbers, or carrier identification numbers. Omit any entry where the value is blank, N/A, unknown, or a dash. Return [] if none found.' },
  { id: 'trailerType',label: 'Trailer Type',      section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'Dry Van, Reefer, Flatbed…', extractionHint: 'Trailer type required, e.g. Dry Van, Reefer, Flatbed, Step Deck' },
  { id: 'trailer',    label: 'Trailer',           section: 'load',      type: 'select', defaultEnabled: false },
  { id: 'broker',     label: 'Broker / Customer', section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'XYZ Logistics',    extractionHint: 'Broker or customer company name' },
  { id: 'dispatcher', label: 'Dispatcher',        section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'John Smith' },
  { id: 'commodity',  label: 'Commodity',         section: 'load',      type: 'text',   defaultEnabled: true,  placeholder: 'Frozen produce, Industrial parts…', extractionHint: 'What is being hauled. Free text from the rate con (e.g. "Frozen blueberries", "Auto parts", "General freight"). If reefer, prepend the temperature setpoint or range. Omit if not stated.' },
  { id: 'weight',     label: 'Weight (lbs)',      section: 'load',      type: 'number', defaultEnabled: true,  placeholder: '40000',            extractionHint: 'Total cargo weight in pounds — number only, no commas or units. Convert from kg/tons if needed. Omit if not stated.' },

  // Financial
  { id: 'loadPrice',     label: 'Load Price ($)',     section: 'financial', type: 'number', defaultEnabled: true,  placeholder: '0.00',    extractionHint: 'Total load rate or price — number only, no $ sign or commas, e.g. 1850.00' },
  { id: 'driverPay',     label: 'Driver Pay ($)',     section: 'financial', type: 'number', defaultEnabled: true,  placeholder: '0.00' },

  // Notes
  { id: 'specialInstructions', label: 'Special Instructions', section: 'notes', type: 'textarea', defaultEnabled: false, placeholder: 'Driver must check in at gate B…', extractionHint: 'Driver-relevant special instructions only — exclude insurance terms, payment terms, and broker/carrier legal language' },
  { id: 'notes', label: 'Notes', section: 'notes', type: 'textarea', defaultEnabled: true, placeholder: 'Add notes…', extractionHint: 'Any additional notes about the load' },
];

export function buildDefaultFieldSettings(): Record<string, boolean> {
  return Object.fromEntries(ALL_FIELDS.map(f => [f.id, f.defaultEnabled]));
}

export function getEnabledFieldsForSection(
  section: FieldSection,
  fieldSettings: Record<string, boolean>,
): FieldDef[] {
  return ALL_FIELDS.filter(f => f.section === section && fieldSettings[f.id]);
}
