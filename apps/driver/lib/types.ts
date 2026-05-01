/**
 * Types mirroring the dispatch-next data model — kept narrow to fields
 * the driver app actually renders. Source of truth lives in
 * dispatch-next/lib/types.ts; we only widen this file when we surface
 * new fields in the mobile UI.
 */

export type LoadStatus =
  | "scheduled"
  | "dispatched"
  | "en_route"
  | "picked_up"
  | "delivered"
  | "cancelled"
  | "tonu"
  | "problem";

export type StopType = "pickup" | "delivery" | "stop" | "drop_hook" | "relay";

export interface Stop {
  id:           string;
  sequence:     number;
  type:         StopType;
  facilityName?: string;
  address?:     string;
  city?:        string;
  timezone?:    string;
  apptStart?:   string; // YYYY-MM-DDTHH:mm (naive, in stop timezone)
  apptEnd?:     string;
  lat?:         number;
  lng?:         number;
  instructions?: string;
  // Driver check-in (set when the driver taps "Check In" on this stop)
  arrivedAt?:   string;  // ISO timestamp
  arrivedLat?:  number;
  arrivedLng?:  number;
}

export interface RefNum {
  label: string;
  value: string;
}

export type TrailerCategory = "Swing" | "Roll Up" | "Flat Bed" | "Other";

export interface Trailer {
  id:             number;
  name:           string;
  trailerNumber?: string;
  category:       TrailerCategory;
}

export interface Load {
  id:              string;  // events.id
  internalLoadId?: number;  // events.internal_load_id — unique internal sequential ID
  loadNum?:        string;  // events.load_num — display-friendly load number
  title:     string;        // events.title — usually "Pickup City → Delivery City"
  start:     string;        // YYYY-MM-DDTHH:mm
  end:       string;
  status:    LoadStatus;
  broker?:   string;
  trailerType?: string;
  trailerId?:   number;
  trailerName?: string;        // joined from trailers table — "Trailer #234"
  driverPay?:   number;
  notes?:    string;
  specialInstructions?: string;
  refNums?:  RefNum[];
  assetName?: string;       // joined from assets table — "Truck 07" etc
  stops:     Stop[];
  // Relay metadata — present when this load is part of a two-event relay pair
  relayGroupId?: string;
  relayRole?:    "pickup" | "delivery";
  partnerStops?: Stop[];           // the partner event's stops (read-only on this driver's side)
  partnerDriverName?: string;
}
