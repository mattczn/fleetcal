export const DUMMY_DRIVER = {
  id: "drv_001",
  name: "Marcus T.",
  phone: "+18015550001",
  truck_number: "07",
  trailer_number: "TR-214",
};

export type LoadStatus = "scheduled" | "in_transit" | "delivered" | "cancelled";

export type StopDetail = {
  facility: string;
  address: string;
  date: string;
  time_window: string;
  notes: string | null;
};

export type Load = {
  load_number: string;
  status: LoadStatus;
  broker: string;
  broker_ref: string;
  pickup: StopDetail;
  delivery: StopDetail;
  commodity: string;
  weight: string;
  miles: number;
  rate: number;
  documents: string[];
};

export const DUMMY_LOADS: Load[] = [
  {
    load_number: "104821",
    status: "in_transit",
    broker: "Coyote Logistics",
    broker_ref: "COY-884421",
    pickup: {
      facility: "Sysco Distribution",
      address: "4800 S 6000 W, Salt Lake City, UT",
      date: "2026-04-11",
      time_window: "06:00 - 08:00",
      notes: "Dock 4, check in with guard",
    },
    delivery: {
      facility: "Walmart DC #7023",
      address: "1200 E Historic Hwy 66, Gallup, NM",
      date: "2026-04-11",
      time_window: "16:00 - 18:00",
      notes: "Call consignee 1hr out",
    },
    commodity: "Dry Grocery",
    weight: "42,500 lbs",
    miles: 418,
    rate: 1850.0,
    documents: [],
  },
  {
    load_number: "104822",
    status: "scheduled",
    broker: "Echo Global",
    broker_ref: "ECH-221043",
    pickup: {
      facility: "Amazon Fulfillment PHX6",
      address: "800 N 75th Ave, Phoenix, AZ",
      date: "2026-04-13",
      time_window: "10:00 - 12:00",
      notes: "Drop and hook, trailer in lot B",
    },
    delivery: {
      facility: "Amazon Fulfillment LAS1",
      address: "3837 Bay Lake Trail, North Las Vegas, NV",
      date: "2026-04-14",
      time_window: "08:00 - 10:00",
      notes: null,
    },
    commodity: "General Freight",
    weight: "38,200 lbs",
    miles: 302,
    rate: 1420.0,
    documents: [],
  },
];
