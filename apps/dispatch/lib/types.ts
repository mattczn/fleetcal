/**
 * Trimmed types for the dispatch-mobile views. Source of truth lives in
 * dispatch-next/lib/types.ts; we widen this file as more fields are surfaced.
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
  apptStart?:   string;
  apptEnd?:     string;
  lat?:         number;
  lng?:         number;
  instructions?: string;
  arrivedAt?:   string;
  arrivedLat?:  number;
  arrivedLng?:  number;
}

export interface Asset {
  id:               number;
  name:             string;
  unit?:            string;
  color?:           string;
  hidden:           boolean;
  sortOrder:        number;
  motiveVehicleId?: string;
}

export interface Driver {
  id:    number;
  name:  string;
  phone?: string;
}

export interface RefNum {
  label: string;
  value: string;
}

export interface Accessorial {
  id?:           string;
  category?:     string;
  description?:  string;
  amount?:       number;
  billable?:     boolean;
  status?:       string;
}

export interface Load {
  id:              string;
  internalLoadId?: number;
  loadNum?:        string;
  title:        string;
  start:        string;
  end:          string;
  status:       LoadStatus;

  // People
  driverId?:    number;
  driverName?:  string;
  driverPhone?: string;
  dispatcher?:  string;
  createdByName?: string;

  // Equipment
  assetId:           number;
  assetName?:        string;
  motiveVehicleId?:  string;
  trailerId?:        number;
  trailerNum?:       string;
  trailerType?:      string;

  // References
  refNums?:     RefNum[];
  bolNum?:      string;
  poNum?:       string;

  // Load info
  broker?:      string;
  commodity?:   string;
  weight?:      number;
  miles?:       number;
  teamLoad?:    boolean;
  hazmat?:      boolean;

  // Quick locations (denormalized — actual stops are in `stops`)
  pickupCity?:    string;
  deliveryCity?:  string;
  pickupAppt?:    string;
  deliveryAppt?:  string;

  // Financial
  loadPrice?:        number;
  driverPay?:        number;
  ratePerMile?:      number;
  fuelSurcharge?:    number;
  factoringCompany?: string;
  invoiceNum?:       string;
  paymentStatus?:    string;

  // State
  dispatched?:  boolean;

  // Notes & meta
  notes?:               string;
  specialInstructions?: string;
  accessorials?:        Accessorial[];
  rateConPdf?:          string; // storage path in `rate-cons` bucket

  // Relay
  relayGroupId?: string;
  relayRole?:    "pickup" | "delivery";
  partnerEventId?:    string;
  partnerStops?:      Stop[];
  partnerDriverName?: string;
  partnerAssetName?:  string;

  stops:        Stop[];
}
