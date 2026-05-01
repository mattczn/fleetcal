import { Asset, CalendarEvent, Driver } from './types';

// Reference date — hydrateDemoMode replaces this with today's real date
export const DEMO_BASE_DATE = '2026-04-23';

const D = DEMO_BASE_DATE;

export const DUMMY_ASSETS: Asset[] = [
  { id: 1, name: 'John',    color: '#1a73e8', type: 'OTR', unit: '101' },
  { id: 2, name: 'Michael', color: '#0B8043', type: 'Local', unit: '102' },
  { id: 3, name: 'Richard', color: '#8E24AA', type: 'Local', unit: '103' },
  { id: 4, name: 'Julio',   color: '#F4511E', type: 'OTR', unit: '104' },
  { id: 5, name: 'Ben',     color: '#D50000', type: 'OTR', unit: '105' },
  { id: 6, name: 'James',   color: '#33B679', type: 'OTR', unit: '106' },
  { id: 7, name: 'Carlos',  color: '#3F51B5', type: 'OTR', unit: '107' },
  { id: 8, name: 'Steve',   color: '#F09300', type: 'OTR', unit: '108' },
  { id: 9, name: 'Nick',    color: '#039BE5', type: 'OTR', unit: '109' },
];

export const DUMMY_DRIVERS: Driver[] = [
  { id: 1, name: 'John'    },
  { id: 2, name: 'Michael' },
  { id: 3, name: 'Richard' },
  { id: 4, name: 'Julio'   },
  { id: 5, name: 'Ben'     },
  { id: 6, name: 'James'   },
  { id: 7, name: 'Carlos'  },
  { id: 8, name: 'Steve'   },
  { id: 9, name: 'Nick'    },
];

export const DUMMY_DRIVER_PREFS: Record<number, number> = {
  1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
};

export const DUMMY_EVENTS: CalendarEvent[] = [
  // John (1) — Forward Air haul
  { id: 'e1',  assetId: 1, title: 'Forward Air: Dallas - Houston',           start: `${D}T06:00`, end: `${D}T14:00`, status: 'en_route',  loadNum: '10201', driverName: 'John'    },

  // Michael (2) — NFI haul
  { id: 'e2',  assetId: 2, title: 'NFI: Chicago - Memphis',                  start: `${D}T05:00`, end: `${D}T15:00`, status: 'picked_up', loadNum: '10202', driverName: 'Michael' },

  // Richard (3) — two legs
  { id: 'e3',  assetId: 3, title: 'Ryan Transport: Atlanta - Nashville',     start: `${D}T07:00`, end: `${D}T13:00`, status: 'en_route',  loadNum: '10203', driverName: 'Richard' },
  { id: 'e4',  assetId: 3, title: 'Arrive Logistics: Nashville - Charlotte', start: `${D}T15:00`, end: `${D}T20:00`, status: 'scheduled', loadNum: '10204', driverName: 'Richard' },

  // Julio (4) — long OTR
  { id: 'e5',  assetId: 4, title: 'Arrive Logistics: Denver - Kansas City',  start: `${D}T04:00`, end: `${D}T18:00`, status: 'en_route',  loadNum: '10205', driverName: 'Julio'   },

  // Ben (5) — Forward Air
  { id: 'e6',  assetId: 5, title: 'Forward Air: Los Angeles - Phoenix',      start: `${D}T06:00`, end: `${D}T16:00`, status: 'scheduled', loadNum: '10206', driverName: 'Ben'     },

  // James (6) — two legs
  { id: 'e7',  assetId: 6, title: 'NFI: Miami - Orlando',                    start: `${D}T07:00`, end: `${D}T10:00`, status: 'delivered', loadNum: '10207', driverName: 'James'   },
  { id: 'e8',  assetId: 6, title: 'Ryan Transport: Orlando - Jacksonville',  start: `${D}T12:30`, end: `${D}T16:00`, status: 'en_route',  loadNum: '10208', driverName: 'James'   },

  // Carlos (7) — two legs
  { id: 'e9',  assetId: 7, title: 'Forward Air: Philadelphia - New York',    start: `${D}T06:00`, end: `${D}T09:00`, status: 'delivered', loadNum: '10209', driverName: 'Carlos'  },
  { id: 'e10', assetId: 7, title: 'Arrive Logistics: New York - Boston',     start: `${D}T11:00`, end: `${D}T14:30`, status: 'en_route',  loadNum: '10210', driverName: 'Carlos'  },

  // Steve (8) — two legs
  { id: 'e11', assetId: 8, title: 'NFI: Seattle - Portland',                 start: `${D}T07:00`, end: `${D}T10:00`, status: 'en_route',  loadNum: '10211', driverName: 'Steve'   },
  { id: 'e12', assetId: 8, title: 'Ryan Transport: Portland - Eugene',       start: `${D}T12:00`, end: `${D}T14:30`, status: 'scheduled', loadNum: '10212', driverName: 'Steve'   },

  // Nick (9) — two legs
  { id: 'e13', assetId: 9, title: 'Forward Air: St. Louis - Indianapolis',   start: `${D}T05:00`, end: `${D}T11:00`, status: 'picked_up', loadNum: '10213', driverName: 'Nick'    },
  { id: 'e14', assetId: 9, title: 'NFI: Indianapolis - Columbus',            start: `${D}T13:00`, end: `${D}T17:00`, status: 'scheduled', loadNum: '10214', driverName: 'Nick'    },

  // Unassigned (id 99) — loads waiting to be assigned
  { id: 'e15', assetId: 99, title: 'Arrive Logistics: Dallas - Fort Worth',  start: `${D}T10:00`, end: `${D}T12:30`, status: 'scheduled', loadNum: '10215' },
  { id: 'e16', assetId: 99, title: 'NFI: Memphis - Nashville',               start: `${D}T14:00`, end: `${D}T18:00`, status: 'scheduled', loadNum: '10216' },
];
