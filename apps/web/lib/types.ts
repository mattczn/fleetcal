export type StopType = 'pickup' | 'delivery' | 'stop' | 'drop_hook' | 'relay';

export const NON_REVENUE_TYPES = ['Maintenance', 'Trailer Move', 'Drop Trailer', 'Deadhead', 'Training', 'Inspection', 'Other'] as const;
export type NonRevenueType = typeof NON_REVENUE_TYPES[number];

export interface Dispatcher {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface Customer {
  id: string;
  name: string;          // canonical display name
  shortName?: string;    // abbreviated name used in auto-generated load titles
  aliases: string[];     // alternative names the AI may extract
  mcNum?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  notes?: string;
}

export type CustomerMatchResult =
  | { status: 'auto';    customer: Customer; score: number }
  | { status: 'confirm'; customer: Customer; score: number }
  | { status: 'new';     extracted: string }
  | { status: 'none' };

export interface SavedLocation {
  id: string;
  name: string;
  address?: string;
  lat?: number;
  lng?: number;
  timezone?: string;
}
export type GeocodeStatus = 'pending' | 'success' | 'failed';

export interface RefNum {
  label: string;
  value: string;
}

export interface Stop {
  id: string;
  eventId: string;
  sequence: number;
  type: StopType;
  facilityName?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  timezone?: string;
  apptStart?: string;
  apptEnd?: string;
  geocodeStatus: GeocodeStatus;
  instructions?: string;
  arrivedAt?:  string;  // driver check-in timestamp (ISO)
  arrivedLat?: number;
  arrivedLng?: number;
}

export interface Driver {
  id: number;
  name: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  notes?: string;
}

export interface Asset {
  id: number;
  name: string;
  color: string;
  type: string;
  unit?: string;
  truck?: string;
  hidden?: boolean;
  notes?: string;
  motiveVehicleId?: string;
}

export type EventStatus = 'scheduled' | 'dispatched' | 'en_route' | 'picked_up' | 'delivered' | 'cancelled' | 'tonu' | 'problem';

export type AccessorialCategory = 'detention' | 'lumper' | 'layover' | 'scale_ticket' | 'other';

export interface Accessorial {
  id: string;
  category: AccessorialCategory;
  description?: string;
  amount: number;
  billable: boolean;
  status?: 'requested' | 'approved' | 'denied';
  /** When true, this accessorial flows into the driver's payroll as an adjustment */
  payToDriver?: boolean;
  /** Optional: override which driver gets paid (defaults to the load's assigned driverName). Used for split/relay loads. */
  payDriverName?: string;
}

export type TrailerCategory = 'Swing' | 'Roll Up' | 'Flat Bed' | 'Other';

export interface Trailer {
  id: number;
  name: string;
  trailerNumber?: string;
  category: TrailerCategory;
  notes?: string;
  motiveVehicleId?: string;
  sortOrder?: number;
}

export interface CalendarEvent {
  id: string;
  internalLoadId?: number;
  assetId: number;
  title: string;
  start: string;       // YYYY-MM-DDTHH:mm (naive Mountain Time)
  end: string;
  driverName?: string;
  driverId?: number;
  status?: EventStatus;
  priority?: boolean;
  eventKind?: 'revenue' | 'non_revenue';
  nonRevenueType?: string;
  relayGroupId?: string;
  relayRole?: 'pickup' | 'delivery';

  // Load Info
  loadNum?: string;
  refNums?: RefNum[];
  broker?: string;
  trailerType?: string;
  trailerId?: number;
  dispatcher?: string;

  // Financial
  loadPrice?: number;
  driverPay?: number;
  detention?: number;
  lumperFees?: number;

  // Notes
  specialInstructions?: string;
  notes?: string;

  // Attachment
  rateConPdf?: string; // base64 data URL

  // Accessorials
  accessorials?: Accessorial[];

  // Stops (multi-stop routing)
  stops?: Stop[];

  // Payroll deferral — weekStart (YYYY-MM-DD) this load's driver pay is deferred to
  deferredToWeek?: string;

  // Audit trail
  createdByName?: string;
  createdAt?: string;       // ISO timestamp from DB
  auditLog?: LoadAuditEntry[];
}

export interface AccessorialChange {
  action: 'added' | 'removed' | 'updated';
  category: string;
  description?: string;
  amount?: number;
  prevAmount?: number;
  newStatus?: string;
  prevStatus?: string;
}

export interface LoadAuditEntry {
  changedAt: string;        // ISO timestamp
  changedByName: string;
  prevDriverName?: string;
  newDriverName?: string;
  prevAssetId?: number;
  newAssetId?: number;
  prevLoadPrice?: number;
  newLoadPrice?: number;
  prevDriverPay?: number;
  newDriverPay?: number;
  stopsAdded?: number;
  stopsRemoved?: number;
  relayCreated?: boolean;
  relayRemoved?: boolean;
  loadDeleted?: boolean;
  loadRestored?: boolean;
  accessorialsChanged?: AccessorialChange[];
  // Driver-app generated entries
  prevStatus?: EventStatus;
  newStatus?: EventStatus;
  documentUploaded?: { fileName: string; kind: string };
  documentDeleted?:  { fileName: string; kind: string };
  stopCheckedIn?:    { stopFacility?: string; stopType?: StopType; distanceMi?: number };
}
