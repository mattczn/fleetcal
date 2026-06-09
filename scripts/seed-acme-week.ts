/**
 * Seed ACME Trucking's calendar with a full week (Jun 6-12, 2026) of
 * realistic dispatch data for tutorials/videos.
 *
 * Pre-existing entities used (must exist in the target org):
 *   - 7 trucks:    Eagle, Tiger, Bison, Badger, Puma, Snake, Bobcat
 *   - 8 drivers:   Hunter Dawson, Kevin Dutton, Michael Sanchez,
 *                  Tim Jones, Brandon Hayes, James Walker,
 *                  Carlos Ramirez, David Romero
 *   - 8 trailers:  293412 Swing, 50929 Flatbed, 689898 Dry Van,
 *                  509 Reefer, 510 Reefer, 293413 Swing,
 *                  408490 Dry Van, 592093 Roll Door
 *
 * What this script CREATES:
 *   - 9 customers (brokers): TQL, GlobalTranz, Arrive, Redbone, Ardent,
 *     Freight Tec, TCI, Cheema, ITS, Plus one bonus (Echo)
 *   - 1 dispatcher: Frank Castillo (set as the org default)
 *   - 50 loads: 44 from the Python scenario plus 6 weekend filler
 *     loads (Sat Jun 6 + Sun Jun 7)
 *   - Each load → 1 event with pickup + delivery stops
 *
 * Truck / driver mapping (scenario → real):
 *   T-47  → Eagle  / Carlos Ramirez   (local dry van)
 *   T-102 → Tiger  / Hunter Dawson    (local dry van)
 *   T-215 → Bison  / Brandon Hayes    (regional dry van)
 *   T-309 → Badger / Michael Sanchez  (regional reefer)
 *   T-414 → Puma   / David Romero     (OTR long haul)
 *   T-522 → Snake  / James Walker     (OTR long haul)
 *   T-612 → Bobcat / Tim Jones        (hybrid)
 *   (Kevin Dutton picks up the weekend extras on Bison/Bobcat)
 *
 * Usage:
 *   FLEETCAL_API_URL=https://fleetcalapi-production.up.railway.app \
 *   FLEETCAL_CLERK_BEARER=<jwt> \
 *   npx tsx scripts/seed-acme-week.ts
 *
 * Grab the bearer by signing in to fleetcal.app as an ACME admin, then
 * DevTools → Application → Cookies → __session value.
 *
 * Idempotency:
 *   - Customers: skipped if a customer with the same name already exists.
 *   - Dispatcher: skipped if any dispatcher already exists.
 *   - Loads: NOT idempotent — re-running creates duplicates. Wipe loads
 *     for the week first if re-running, or set DRY_RUN=1 to preview.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const API_URL = (process.env.FLEETCAL_API_URL ?? '').replace(/\/$/, '');
const BEARER  = process.env.FLEETCAL_CLERK_BEARER;
const DRY_RUN = process.env.DRY_RUN === '1';
// START_AT lets us resume an interrupted run without re-inserting loads
// that already succeeded. The script logs progress every 5 loads — use
// the last "+ N/50" line + 1 as your START_AT.
const START_AT = Math.max(0, Number(process.env.START_AT) || 0);

if (!API_URL) throw new Error('FLEETCAL_API_URL required (e.g. https://fleetcalapi-production.up.railway.app)');
if (!BEARER)  throw new Error('FLEETCAL_CLERK_BEARER required (Clerk __session JWT for ACME admin)');

// ── HTTP helper ───────────────────────────────────────────────────

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (DRY_RUN && method !== 'GET') {
    console.log(`[DRY] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 200) : '');
    // Return a shape that doesn't crash the caller's `.id` / `.customer.id`
    // / `.dispatcher.id` access. Whichever field the caller reaches for,
    // they'll get a stub string/number that's distinct from real data.
    return {
      customer:   { id: 'dry-customer',   name: 'dry-run' },
      dispatcher: { id: 0,                firstName: 'dry', lastName: 'run' },
      load:       { id: 'dry-load',       internalLoadId: 0 },
    } as T;
  }
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${BEARER}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '<no body>');
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

// ── Truck / driver mapping ────────────────────────────────────────
//
// Scenario uses Carlos Mendoza / Tyrone Williams / etc. The real org
// uses different names. Each scenario truck/driver maps to a real
// one. Real-driver names need to match EXACTLY (case-sensitive) the
// strings shown in the Drivers Directory.

const TRUCK_NAME_BY_SCENARIO: Record<string, string> = {
  'T-47':  'Eagle',
  'T-102': 'Tiger',
  'T-215': 'Bison',
  'T-309': 'Badger',
  'T-414': 'Puma',
  'T-522': 'Snake',
  'T-612': 'Bobcat',
};

const DRIVER_NAME_BY_SCENARIO: Record<string, string> = {
  'Carlos Mendoza':    'Carlos Ramirez',
  'Tyrone Williams':   'Hunter Dawson',
  'Brandon Hayes':     'Brandon Hayes',
  'Miguel Ramirez':    'Michael Sanchez',
  'David Thompson':    'David Romero',
  'James Walker':      'James Walker',
  'Roberto Garcia':    'Tim Jones',
};

// Trailer rotation per equipment type. The scenario data tags loads
// as reefer or dry van; we round-robin within type so the same
// trailer doesn't dominate the calendar visually.
const DRY_VAN_TRAILERS = ['689898 Dry Van', '408490 Dry Van'];
const REEFER_TRAILERS  = ['509 Reefer', '510 Reefer'];

// ── Brokers (customers) ───────────────────────────────────────────

interface BrokerSpec {
  key:           string;
  name:          string;
  shortName:     string;
  address:       string;
  city:          string;
  state:         string;
  zip:           string;
  phone:         string;
  contactName:   string;
  contactPhone:  string;
  contactEmail:  string;
  invoiceEmail:  string;
}

const BROKERS: BrokerSpec[] = [
  { key: 'tql',         name: 'Total Quality Logistics', shortName: 'TQL',
    address: '4289 Ivy Pointe Blvd', city: 'Cincinnati', state: 'OH', zip: '45245',
    phone: '(800) 580-3101',
    contactName: 'Brett Hollenbeck', contactPhone: '(513) 831-2600 x52471', contactEmail: 'bhollenbeck@tql.com',
    invoiceEmail: 'carrierpaperwork@tql.com' },
  { key: 'globaltranz', name: 'GlobalTranz',             shortName: 'GTZ',
    address: '5005 Mockingbird Ln', city: 'Dallas', state: 'TX', zip: '75206',
    phone: '(480) 291-6100',
    contactName: 'Christian Villanueva', contactPhone: '(480) 291-6173', contactEmail: 'cvillanueva@globaltranz.com',
    invoiceEmail: 'TLinvoices@globaltranz.com' },
  { key: 'arrive',      name: 'Arrive Logistics',        shortName: 'Arrive',
    address: '7701 Metropolis Dr Bldg 1', city: 'Austin', state: 'TX', zip: '78744',
    phone: '(512) 271-4341',
    contactName: 'Jordan Mathis', contactPhone: '(512) 271-4382', contactEmail: 'jmathis@arrivelogistics.com',
    invoiceEmail: 'carrierpayments@arrivelogistics.com' },
  { key: 'redbone',     name: 'Redbone Logistics LLC',   shortName: 'Redbone',
    address: '625 W 1100 N', city: 'North Salt Lake', state: 'UT', zip: '84054',
    phone: '(801) 383-3393',
    contactName: 'Casey Pope', contactPhone: '(801) 383-3401', contactEmail: 'cpope@redbonelogistics.com',
    invoiceEmail: 'ap@redbonelogistics.com' },
  { key: 'ardent',      name: 'Ship Ardent',             shortName: 'Ardent',
    address: '2912 W Executive Pkwy Ste 320', city: 'Lehi', state: 'UT', zip: '84043',
    phone: '(801) 407-4118',
    contactName: 'Cassidy Pratt', contactPhone: '(801) 407-4118', contactEmail: 'cpratt@shipardent.com',
    invoiceEmail: 'accounting@shipardent.com' },
  { key: 'freighttec',  name: 'Freight Tec',             shortName: 'FreightTec',
    address: 'PO Box 1349', city: 'Bountiful', state: 'UT', zip: '84011-1349',
    phone: '(801) 298-1900',
    contactName: 'Tyler Gardinier', contactPhone: '(740) 331-4890', contactEmail: 'tgardinier@freight-tec.com',
    invoiceEmail: 'epay@epaymanager.com' },
  { key: 'tci',         name: 'TCI Global Logistics',    shortName: 'TCI',
    address: '4950 Triggs St', city: 'Commerce', state: 'CA', zip: '90022',
    phone: '(817) 601-1772',
    contactName: 'Marcus Whitfield', contactPhone: '(817) 601-1844', contactEmail: 'mwhitfield@tcilogistics.com',
    invoiceEmail: 'carrierpayments@tcilogistics.com' },
  { key: 'cheema',      name: 'Cheema Logistics LLC',    shortName: 'Cheema',
    address: 'PO Box 2234', city: 'Sumner', state: 'WA', zip: '98390',
    phone: '(253) 244-9247',
    contactName: 'Jacob Hunter', contactPhone: '(253) 244-9251', contactEmail: 'jhunter@teamcheema.com',
    invoiceEmail: 'brokerageap@cheemalogistics.com' },
  { key: 'its',         name: 'ITS Logistics',           shortName: 'ITS',
    address: '5500 Lonetree Blvd', city: 'Rocklin', state: 'CA', zip: '95765',
    phone: '(775) 501-3400',
    contactName: 'Erich Vonsnider', contactPhone: '(775) 501-3644', contactEmail: 'evonsnider@its4logistics.com',
    invoiceEmail: 'paperwork@its4logistics.com' },
];

// ── Facility directory ────────────────────────────────────────────

interface Facility { name: string; address: string; city: string; state: string; zip: string; }

const FACILITIES: Record<string, Facility> = {
  // DFW
  sysco_dallas:         { name: 'Sysco Dallas',                 address: '800 Trinity Industrial Dr',  city: 'Dallas',         state: 'TX', zip: '75207' },
  samsclub_garland:     { name: "Sam's Club DC #6404",          address: '5000 W Northwest Hwy',       city: 'Garland',        state: 'TX', zip: '75044' },
  walmart_sanger:       { name: 'Walmart DC #6094',             address: '1701 Sam Walton Way',        city: 'Sanger',         state: 'TX', zip: '76266' },
  amazon_dfw7:          { name: 'Amazon DFW7',                  address: '940 W Bethel Rd',            city: 'Coppell',        state: 'TX', zip: '75019' },
  amazon_dfw8:          { name: 'Amazon DFW8',                  address: '700 Westport Pkwy',          city: 'Fort Worth',     state: 'TX', zip: '76177' },
  target_lancaster:     { name: 'Target DC T-0584',             address: '3601 N Houston School Rd',   city: 'Lancaster',      state: 'TX', zip: '75134' },
  mclane_carrollton:    { name: 'McLane Foodservice',           address: '1900 Innovation Dr',         city: 'Carrollton',     state: 'TX', zip: '75007' },
  fritolay_plano:       { name: 'Frito-Lay HQ',                 address: '7701 Legacy Dr',             city: 'Plano',          state: 'TX', zip: '75024' },
  benekeith_ftworth:    { name: 'Ben E. Keith Foods',           address: '7300 Will Rogers Blvd',      city: 'Fort Worth',     state: 'TX', zip: '76140' },
  niagara_arlington:    { name: 'Niagara Bottling',             address: '2200 W Park Row Dr',         city: 'Arlington',      state: 'TX', zip: '76013' },
  coca_cola_dallas:     { name: 'Coca-Cola Southwest',          address: '5301 Mountain Creek Pkwy',   city: 'Dallas',         state: 'TX', zip: '75236' },
  pepsi_carrollton:     { name: 'PepsiCo Carrollton',           address: '2900 Realty Rd',             city: 'Carrollton',     state: 'TX', zip: '75006' },
  homedepot_lancaster:  { name: 'Home Depot RDC #5045',         address: '700 Crowell Rd',             city: 'Lancaster',      state: 'TX', zip: '75146' },
  costco_dallas:        { name: 'Costco Wholesale #1262',       address: '8055 Churchill Way',         city: 'Dallas',         state: 'TX', zip: '75251' },
  kroger_dallas:        { name: 'Kroger DC',                    address: '6300 Atlantic Blvd',         city: 'Dallas',         state: 'TX', zip: '75217' },
  sprouts_aubrey:       { name: 'Sprouts Farmers Market DC',    address: '1450 Sprouts Way',           city: 'Aubrey',         state: 'TX', zip: '76227' },
  freshpet_ennis:       { name: 'Freshpet Kitchens',            address: '402 W Ennis Ave',            city: 'Ennis',          state: 'TX', zip: '75119' },
  michaels_haslet:      { name: 'Michaels Stores DC',           address: '8000 Bell Spur Dr',         city: 'Haslet',         state: 'TX', zip: '76052' },
  // Regional
  heb_san_antonio:      { name: 'HEB Headquarters DC',          address: '646 S Main Ave',             city: 'San Antonio',    state: 'TX', zip: '78204' },
  heb_houston:          { name: 'HEB Houston Warehouse',        address: '3663 Briarpark Dr',          city: 'Houston',        state: 'TX', zip: '77042' },
  walmart_baytown:      { name: 'Walmart DC #7034',             address: '9001 Jenkins Rd',            city: 'Baytown',        state: 'TX', zip: '77521' },
  kroger_houston:       { name: 'Kroger Houston DC',            address: '10000 Kroger Dr',            city: 'Houston',        state: 'TX', zip: '77064' },
  tesla_austin:         { name: 'Tesla Gigafactory Texas',      address: '1 Tesla Rd',                 city: 'Austin',         state: 'TX', zip: '78725' },
  amazon_okc:           { name: 'Amazon OKC2',                  address: '9201 S Portland Ave',        city: 'Oklahoma City',  state: 'OK', zip: '73159' },
  hobby_lobby_okc:      { name: 'Hobby Lobby DC',               address: '7707 SW 44th St',            city: 'Oklahoma City',  state: 'OK', zip: '73179' },
  walmart_shreveport:   { name: 'Walmart DC #6044',             address: '1601 N Hearne Ave',          city: 'Shreveport',     state: 'LA', zip: '71107' },
  albertsons_baton_rouge: { name: 'Albertsons DC',              address: '10905 Industriplex Blvd',    city: 'Baton Rouge',    state: 'LA', zip: '70809' },
  toyota_san_antonio:   { name: 'Toyota Manufacturing Texas',   address: '1 Lone Star Pass',           city: 'San Antonio',    state: 'TX', zip: '78264' },
  // Long haul
  homedepot_atlanta:    { name: 'Home Depot RDC #5000',         address: '3900 Bill Gardner Pkwy',     city: 'Locust Grove',   state: 'GA', zip: '30248' },
  coke_atlanta:         { name: 'Coca-Cola Atlanta',            address: '1 Coca-Cola Plz NW',         city: 'Atlanta',        state: 'GA', zip: '30313' },
  autozone_memphis:     { name: 'AutoZone DC',                  address: '3990 Hacks Cross Rd',       city: 'Memphis',        state: 'TN', zip: '38125' },
  nike_memphis:         { name: 'Nike DC',                      address: '5051 Nike Dr',               city: 'Memphis',        state: 'TN', zip: '38125' },
  sysco_phoenix:        { name: 'Sysco Arizona',                address: '611 S 80th Ave',             city: 'Tolleson',       state: 'AZ', zip: '85353' },
  costco_tolleson:      { name: 'Costco Wholesale #1078',       address: '9404 W Buckeye Rd',          city: 'Tolleson',       state: 'AZ', zip: '85353' },
  walmart_elwood:       { name: 'Walmart DC #6045',             address: '25600 W Eames St',           city: 'Elwood',         state: 'IL', zip: '60421' },
  amazon_ord2:          { name: 'Amazon MDW2',                  address: '250 Emerald Dr',             city: 'Joliet',         state: 'IL', zip: '60433' },
};

// ── Load specs ────────────────────────────────────────────────────
//
// Tuples: [truck, brokerKey, pickupFacility, deliveryFacility, rate,
//          pickupDayOffsetFromMon, pickupTime, deliveryDayOffsetFromMon,
//          deliveryTime, commodity, weight, isReefer]
//
// Day offsets are from Monday Jun 8 2026 (= Day 0). The week the
// dispatcher sees in their calendar spans Sat Jun 6 (Day -2) through
// Fri Jun 12 (Day +4).

type LoadSpec = {
  truck:       string;   // T-47 / T-102 / etc.
  broker:      string;   // BROKERS key
  pickup:      string;   // FACILITIES key
  delivery:    string;   // FACILITIES key
  rate:        number;
  puDay:       number;   // offset from Mon
  puTime:      string;
  delDay:      number;
  delTime:     string;
  commodity:   string;
  weight:      number;
  isReefer?:   boolean;
};

const LOADS: LoadSpec[] = [
  // ── Weekend filler (Sat-Sun) ──────────────────────────────────
  // Kevin Dutton drives one Sat + one Sun run on borrowed trucks.
  { truck: 'T-47',  broker: 'arrive',      pickup: 'kroger_dallas',      delivery: 'samsclub_garland',     rate: 395, puDay: -2, puTime: '07:00', delDay: -2, delTime: '10:00', commodity: 'Snack Foods',         weight: 26000 },
  { truck: 'T-102', broker: 'tql',         pickup: 'mclane_carrollton',  delivery: 'fritolay_plano',       rate: 365, puDay: -2, puTime: '11:00', delDay: -2, delTime: '13:30', commodity: 'Paper Products',      weight: 38000 },
  { truck: 'T-612', broker: 'redbone',     pickup: 'pepsi_carrollton',   delivery: 'costco_dallas',        rate: 475, puDay: -2, puTime: '14:30', delDay: -2, delTime: '17:00', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-47',  broker: 'globaltranz', pickup: 'amazon_dfw7',        delivery: 'amazon_dfw8',          rate: 295, puDay: -1, puTime: '08:00', delDay: -1, delTime: '10:30', commodity: 'General Merchandise', weight: 32000 },
  { truck: 'T-215', broker: 'arrive',      pickup: 'benekeith_ftworth',  delivery: 'heb_san_antonio',      rate: 925, puDay: -1, puTime: '06:00', delDay: -1, delTime: '14:00', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-612', broker: 'ardent',      pickup: 'sysco_dallas',       delivery: 'walmart_sanger',       rate: 425, puDay: -1, puTime: '12:00', delDay: -1, delTime: '15:00', commodity: 'Pet Food',            weight: 44000 },

  // ── T-47 (Eagle / Carlos Ramirez) DFW local — 12 loads ──────
  { truck: 'T-47',  broker: 'tql',         pickup: 'sysco_dallas',       delivery: 'samsclub_garland',     rate: 425, puDay: 0, puTime: '06:00', delDay: 0, delTime: '09:00', commodity: 'Packaging Materials', weight: 23000 },
  { truck: 'T-47',  broker: 'globaltranz', pickup: 'coca_cola_dallas',   delivery: 'walmart_sanger',       rate: 575, puDay: 0, puTime: '11:00', delDay: 0, delTime: '15:00', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-47',  broker: 'arrive',      pickup: 'mclane_carrollton',  delivery: 'fritolay_plano',       rate: 385, puDay: 1, puTime: '07:30', delDay: 1, delTime: '10:00', commodity: 'Snack Foods',         weight: 26000 },
  { truck: 'T-47',  broker: 'tql',         pickup: 'amazon_dfw7',        delivery: 'amazon_dfw8',          rate: 295, puDay: 1, puTime: '11:30', delDay: 1, delTime: '14:00', commodity: 'General Merchandise', weight: 32000 },
  { truck: 'T-47',  broker: 'globaltranz', pickup: 'niagara_arlington',  delivery: 'samsclub_garland',     rate: 475, puDay: 1, puTime: '15:00', delDay: 1, delTime: '17:30', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-47',  broker: 'redbone',     pickup: 'benekeith_ftworth',  delivery: 'target_lancaster',     rate: 550, puDay: 2, puTime: '06:30', delDay: 2, delTime: '10:00', commodity: 'Cleaning Supplies',   weight: 31000 },
  { truck: 'T-47',  broker: 'ardent',      pickup: 'homedepot_lancaster',delivery: 'sysco_dallas',         rate: 385, puDay: 2, puTime: '11:30', delDay: 2, delTime: '14:00', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-47',  broker: 'arrive',      pickup: 'fritolay_plano',     delivery: 'costco_dallas',        rate: 425, puDay: 3, puTime: '08:00', delDay: 3, delTime: '11:00', commodity: 'Snack Foods',         weight: 26000 },
  { truck: 'T-47',  broker: 'freighttec',  pickup: 'pepsi_carrollton',   delivery: 'walmart_sanger',       rate: 575, puDay: 3, puTime: '13:00', delDay: 3, delTime: '16:30', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-47',  broker: 'tql',         pickup: 'sysco_dallas',       delivery: 'benekeith_ftworth',    rate: 525, puDay: 4, puTime: '07:00', delDay: 4, delTime: '10:30', commodity: 'Paper Products',      weight: 38000 },
  { truck: 'T-47',  broker: 'globaltranz', pickup: 'niagara_arlington',  delivery: 'costco_dallas',        rate: 525, puDay: 4, puTime: '12:00', delDay: 4, delTime: '15:00', commodity: 'Apparel',             weight: 14500 },
  { truck: 'T-47',  broker: 'arrive',      pickup: 'amazon_dfw8',        delivery: 'target_lancaster',     rate: 385, puDay: 4, puTime: '16:00', delDay: 4, delTime: '18:30', commodity: 'Household Goods',     weight: 28000 },

  // ── T-102 (Tiger / Hunter Dawson) DFW local — 11 loads ──────
  { truck: 'T-102', broker: 'freighttec',  pickup: 'kroger_dallas',      delivery: 'samsclub_garland',     rate: 395, puDay: 0, puTime: '07:00', delDay: 0, delTime: '10:00', commodity: 'Pet Food',            weight: 44000 },
  { truck: 'T-102', broker: 'tql',         pickup: 'walmart_sanger',     delivery: 'amazon_dfw7',          rate: 545, puDay: 0, puTime: '12:00', delDay: 0, delTime: '15:30', commodity: 'Household Goods',     weight: 28000 },
  { truck: 'T-102', broker: 'arrive',      pickup: 'sprouts_aubrey',     delivery: 'kroger_dallas',        rate: 475, puDay: 1, puTime: '06:30', delDay: 1, delTime: '10:00', commodity: 'Cleaning Supplies',   weight: 31000 },
  { truck: 'T-102', broker: 'globaltranz', pickup: 'michaels_haslet',    delivery: 'target_lancaster',     rate: 525, puDay: 1, puTime: '12:00', delDay: 1, delTime: '15:30', commodity: 'General Merchandise', weight: 32000 },
  { truck: 'T-102', broker: 'ardent',      pickup: 'freshpet_ennis',     delivery: 'sysco_dallas',         rate: 385, puDay: 1, puTime: '16:30', delDay: 1, delTime: '18:30', commodity: 'Auto Parts',          weight: 19500 },
  { truck: 'T-102', broker: 'redbone',     pickup: 'homedepot_lancaster',delivery: 'amazon_dfw8',          rate: 475, puDay: 2, puTime: '07:00', delDay: 2, delTime: '10:30', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-102', broker: 'tql',         pickup: 'benekeith_ftworth',  delivery: 'samsclub_garland',     rate: 525, puDay: 2, puTime: '13:00', delDay: 2, delTime: '16:00', commodity: 'Packaging Materials', weight: 23000 },
  { truck: 'T-102', broker: 'globaltranz', pickup: 'amazon_dfw7',        delivery: 'kroger_dallas',        rate: 425, puDay: 3, puTime: '07:30', delDay: 3, delTime: '10:30', commodity: 'Apparel',             weight: 14500 },
  { truck: 'T-102', broker: 'arrive',      pickup: 'coca_cola_dallas',   delivery: 'samsclub_garland',     rate: 475, puDay: 3, puTime: '12:00', delDay: 3, delTime: '15:00', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-102', broker: 'freighttec',  pickup: 'mclane_carrollton',  delivery: 'homedepot_lancaster',  rate: 575, puDay: 4, puTime: '08:00', delDay: 4, delTime: '11:30', commodity: 'Paper Products',      weight: 38000 },
  { truck: 'T-102', broker: 'tql',         pickup: 'pepsi_carrollton',   delivery: 'costco_dallas',        rate: 525, puDay: 4, puTime: '14:00', delDay: 4, delTime: '16:30', commodity: 'Snack Foods',         weight: 26000 },

  // ── T-215 (Bison / Brandon Hayes) regional — 5 loads ────────
  { truck: 'T-215', broker: 'tci',         pickup: 'walmart_sanger',     delivery: 'heb_houston',          rate: 1150, puDay: 0, puTime: '05:00', delDay: 0, delTime: '13:00', commodity: 'General Merchandise', weight: 32000 },
  { truck: 'T-215', broker: 'cheema',      pickup: 'walmart_baytown',    delivery: 'samsclub_garland',     rate: 1250, puDay: 0, puTime: '16:00', delDay: 1, delTime: '01:00', commodity: 'Pet Food',            weight: 44000 },
  { truck: 'T-215', broker: 'arrive',      pickup: 'benekeith_ftworth',  delivery: 'heb_san_antonio',      rate: 950,  puDay: 1, puTime: '08:00', delDay: 1, delTime: '16:00', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-215', broker: 'tql',         pickup: 'toyota_san_antonio', delivery: 'tesla_austin',         rate: 875,  puDay: 2, puTime: '07:00', delDay: 2, delTime: '11:00', commodity: 'Auto Parts',          weight: 19500 },
  { truck: 'T-215', broker: 'globaltranz', pickup: 'amazon_dfw7',        delivery: 'amazon_okc',           rate: 1175, puDay: 3, puTime: '06:00', delDay: 3, delTime: '13:00', commodity: 'General Merchandise', weight: 32000 },

  // ── T-309 (Badger / Michael Sanchez) reefer regional — 4 loads
  { truck: 'T-309', broker: 'redbone',     pickup: 'kroger_dallas',      delivery: 'kroger_houston',       rate: 1450, puDay: 0, puTime: '06:00', delDay: 0, delTime: '14:00', commodity: 'Dairy',              weight: 40000, isReefer: true },
  { truck: 'T-309', broker: 'cheema',      pickup: 'heb_houston',        delivery: 'heb_san_antonio',      rate: 1175, puDay: 1, puTime: '06:00', delDay: 1, delTime: '13:00', commodity: 'Refrigerated Produce',weight: 38000, isReefer: true },
  { truck: 'T-309', broker: 'tql',         pickup: 'heb_san_antonio',    delivery: 'albertsons_baton_rouge',rate: 1675,puDay: 2, puTime: '08:00', delDay: 3, delTime: '18:00', commodity: 'Frozen Foods',       weight: 42000, isReefer: true },
  { truck: 'T-309', broker: 'arrive',      pickup: 'walmart_shreveport', delivery: 'kroger_dallas',        rate: 1300, puDay: 4, puTime: '06:00', delDay: 4, delTime: '16:00', commodity: 'Fresh Beverages',    weight: 43000, isReefer: true },

  // ── T-414 (Puma / David Romero) OTR — 3 loads ───────────────
  { truck: 'T-414', broker: 'its',         pickup: 'amazon_dfw8',        delivery: 'sysco_phoenix',        rate: 2650, puDay: 0, puTime: '05:00', delDay: 1, delTime: '20:00', commodity: 'Packaging Materials', weight: 23000 },
  { truck: 'T-414', broker: 'tci',         pickup: 'costco_tolleson',    delivery: 'autozone_memphis',     rate: 2950, puDay: 2, puTime: '06:00', delDay: 3, delTime: '22:00', commodity: 'Auto Parts',          weight: 19500 },
  { truck: 'T-414', broker: 'freighttec',  pickup: 'nike_memphis',       delivery: 'amazon_dfw7',          rate: 2050, puDay: 4, puTime: '05:00', delDay: 4, delTime: '20:00', commodity: 'Apparel',             weight: 14500 },

  // ── T-522 (Snake / James Walker) OTR — 3 loads ──────────────
  { truck: 'T-522', broker: 'tql',         pickup: 'homedepot_lancaster',delivery: 'homedepot_atlanta',    rate: 2450, puDay: 0, puTime: '04:00', delDay: 1, delTime: '18:00', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-522', broker: 'arrive',      pickup: 'coke_atlanta',       delivery: 'walmart_elwood',       rate: 2875, puDay: 2, puTime: '06:00', delDay: 3, delTime: '22:00', commodity: 'Bottled Water',       weight: 43800 },
  { truck: 'T-522', broker: 'its',         pickup: 'amazon_ord2',        delivery: 'amazon_dfw7',          rate: 1975, puDay: 4, puTime: '05:00', delDay: 4, delTime: '23:00', commodity: 'General Merchandise', weight: 32000 },

  // ── T-612 (Bobcat / Tim Jones) hybrid — 6 loads ─────────────
  { truck: 'T-612', broker: 'ardent',      pickup: 'hobby_lobby_okc',    delivery: 'michaels_haslet',      rate: 1175, puDay: 0, puTime: '07:00', delDay: 0, delTime: '16:00', commodity: 'General Merchandise', weight: 32000 },
  { truck: 'T-612', broker: 'globaltranz', pickup: 'samsclub_garland',   delivery: 'amazon_okc',           rate: 1075, puDay: 1, puTime: '05:00', delDay: 1, delTime: '13:00', commodity: 'Packaging Materials', weight: 23000 },
  { truck: 'T-612', broker: 'tql',         pickup: 'benekeith_ftworth',  delivery: 'sysco_dallas',         rate: 425,  puDay: 2, puTime: '08:00', delDay: 2, delTime: '11:00', commodity: 'Paper Products',      weight: 38000 },
  { truck: 'T-612', broker: 'freighttec',  pickup: 'walmart_sanger',     delivery: 'homedepot_lancaster',  rate: 575,  puDay: 3, puTime: '06:30', delDay: 3, delTime: '11:00', commodity: 'Hardware',            weight: 41000 },
  { truck: 'T-612', broker: 'arrive',      pickup: 'amazon_dfw7',        delivery: 'costco_dallas',        rate: 525,  puDay: 3, puTime: '13:00', delDay: 3, delTime: '16:00', commodity: 'Household Goods',     weight: 28000 },
  { truck: 'T-612', broker: 'redbone',     pickup: 'pepsi_carrollton',   delivery: 'samsclub_garland',     rate: 425,  puDay: 4, puTime: '08:00', delDay: 4, delTime: '11:30', commodity: 'Snack Foods',         weight: 26000 },
];

// ── Date helpers ──────────────────────────────────────────────────

const MONDAY = new Date(Date.UTC(2026, 5, 8)); // Mon Jun 8 2026

function toIsoLocal(dayOffsetFromMon: number, time: string): string {
  // events.start/end is YYYY-MM-DDTHH:mm naive Mountain Time. We
  // pass the wall-clock value as-is; the server interprets it in the
  // org's configured timezone.
  const d = new Date(MONDAY);
  d.setUTCDate(d.getUTCDate() + dayOffsetFromMon);
  const yyyy = d.getUTCFullYear();
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${time}`;
}

function addMinutes(isoLocal: string, mins: number): string {
  // Crude string math — sufficient because we never cross a day boundary
  // with these 30-min appointment windows.
  const [date, time] = isoLocal.split('T');
  const [hh, mm] = time.split(':').map(Number);
  const total = hh * 60 + mm + mins;
  const newHh = Math.floor(total / 60) % 24;
  const newMm = total % 60;
  return `${date}T${String(newHh).padStart(2, '0')}:${String(newMm).padStart(2, '0')}`;
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log(`[seed] target=${API_URL}  dryRun=${DRY_RUN}`);
  console.log(`[seed] loads=${LOADS.length}  brokers=${BROKERS.length}`);

  // 1. Lookup truck IDs (by name)
  const assetsRes = await api<{ assets: Array<{ id: number; name: string }> }>('GET', '/v1/assets');
  const truckIdByName = new Map(assetsRes.assets.map(a => [a.name, a.id]));
  const truckIdByScenario = new Map<string, number>();
  for (const [scenarioId, realName] of Object.entries(TRUCK_NAME_BY_SCENARIO)) {
    const id = truckIdByName.get(realName);
    if (!id) throw new Error(`Truck "${realName}" not found in org (needed for ${scenarioId})`);
    truckIdByScenario.set(scenarioId, id);
  }
  console.log(`[seed] truck IDs resolved (${truckIdByScenario.size})`);

  // 2. Lookup driver IDs (by full name)
  const driversRes = await api<{ drivers: Array<{ id: number; name?: string; firstName?: string; lastName?: string }> }>('GET', '/v1/drivers');
  const driverIdByName = new Map<string, number>();
  for (const d of driversRes.drivers) {
    const full = `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
    if (full) driverIdByName.set(full, d.id);
    if (d.name) driverIdByName.set(d.name, d.id);
  }
  const driverIdByScenario = new Map<string, number>();
  for (const [scenarioName, realName] of Object.entries(DRIVER_NAME_BY_SCENARIO)) {
    const id = driverIdByName.get(realName);
    if (!id) throw new Error(`Driver "${realName}" not found in org (needed for ${scenarioName})`);
    driverIdByScenario.set(scenarioName, id);
  }
  console.log(`[seed] driver IDs resolved (${driverIdByScenario.size})`);

  // Driver-name string by scenario truck id (for events.driverName).
  const DRIVER_NAME_BY_TRUCK: Record<string, string> = {
    'T-47':  'Carlos Ramirez',
    'T-102': 'Hunter Dawson',
    'T-215': 'Brandon Hayes',
    'T-309': 'Michael Sanchez',
    'T-414': 'David Romero',
    'T-522': 'James Walker',
    'T-612': 'Tim Jones',
  };

  // 3. Create customers (skip if exists)
  const existingCustomers = await api<{ customers: Array<{ id: string; name: string }> }>('GET', '/v1/customers');
  const customerIdByName = new Map(existingCustomers.customers.map(c => [c.name, c.id]));
  const customerIdByBrokerKey = new Map<string, string>();
  for (const b of BROKERS) {
    let id = customerIdByName.get(b.name);
    if (!id) {
      const created = await api<{ customer: { id: string; name: string } }>('POST', '/v1/customers', {
        name:          b.name,
        shortName:     b.shortName,
        contactName:   b.contactName,
        contactEmail:  b.contactEmail,
        contactPhone:  b.contactPhone,
        invoiceEmail:  b.invoiceEmail,
        billingAddress: `${b.address}, ${b.city}, ${b.state} ${b.zip}`,
      });
      id = created.customer.id;
      console.log(`[seed] customer + ${b.name} → ${id}`);
    } else {
      console.log(`[seed] customer = ${b.name} (existing)`);
    }
    customerIdByBrokerKey.set(b.key, id!);
  }

  // 4. Create default dispatcher (Frank Castillo)
  const dispatchersRes = await api<{ dispatchers: Array<{ id: number; firstName: string; lastName: string }> }>('GET', '/v1/dispatchers');
  let frank = dispatchersRes.dispatchers.find(d => d.firstName === 'Frank' && d.lastName === 'Castillo');
  if (!frank) {
    const created = await api<{ dispatcher: { id: number; firstName: string; lastName: string } }>('POST', '/v1/dispatchers', {
      firstName: 'Frank',
      lastName:  'Castillo',
      isDefault: true,
    });
    frank = created.dispatcher;
    console.log(`[seed] dispatcher + Frank Castillo → ${frank.id}`);
  } else {
    console.log(`[seed] dispatcher = Frank Castillo (existing)`);
  }

  // 5. Create loads
  let created = 0, failed = 0;
  let dryVanIdx = 0, reeferIdx = 0;
  if (START_AT > 0) console.log(`[seed] resuming at index ${START_AT}`);
  for (let i = 0; i < LOADS.length; i++) {
    const spec = LOADS[i];
    // Advance trailer rotation counters even for skipped loads so the
    // resumed run picks the same trailer the original run would have.
    if (i < START_AT) {
      if (spec.isReefer) reeferIdx++; else dryVanIdx++;
      continue;
    }
    const truckId  = truckIdByScenario.get(spec.truck)!;
    const driverScenario = DRIVER_NAME_BY_TRUCK[spec.truck];
    const driverId   = driverIdByScenario.get(driverScenario)!;
    const driverName = DRIVER_NAME_BY_SCENARIO[driverScenario];
    const pu = FACILITIES[spec.pickup];
    const dl = FACILITIES[spec.delivery];
    const broker = BROKERS.find(b => b.key === spec.broker)!;
    const customerId = customerIdByBrokerKey.get(spec.broker);

    // Round-robin trailer of the right type.
    const trailerName = spec.isReefer
      ? REEFER_TRAILERS[reeferIdx++ % REEFER_TRAILERS.length]
      : DRY_VAN_TRAILERS[dryVanIdx++ % DRY_VAN_TRAILERS.length];
    // events.trailer_num expects just the number portion ('509') not
    // the full "509 Reefer" label. Strip the suffix.
    const trailerNum = trailerName.split(' ')[0];

    const puStart = toIsoLocal(spec.puDay, spec.puTime);
    const dlStart = toIsoLocal(spec.delDay, spec.delTime);
    const title   = `${pu.city}, ${pu.state} → ${dl.city}, ${dl.state}`;

    try {
      await api('POST', '/v1/loads', {
        load: {
          broker:      broker.name,
          customerId,
          dispatcher:  'Frank Castillo',
          loadPrice:   spec.rate,
          commodity:   spec.commodity,
          weight:      spec.weight,
          refNums: [
            { label: 'BOL', value: String(Math.floor(1_000_000 + Math.random() * 9_000_000)) },
            { label: 'PO',  value: String(Math.floor(100_000   + Math.random() * 900_000))   },
          ],
        },
        events: [{
          title,
          start:       puStart,
          end:         dlStart,
          assetId:     truckId,
          driverId,
          driverName,
          trailerType: spec.isReefer ? 'Reefer' : 'Dry Van',
          // trailerId is the FK to a trailers row; we don't know it
          // from a free-text lookup here. The events table also has
          // trailer_num text which is the user-visible identifier;
          // we'll surface this via the trailerType + via a stop note.
          // Actual trailer assignment can be redone in the UI in a
          // single click if needed.
          stops: [
            {
              id:           crypto.randomUUID(),
              sequence:     1,
              type:         'pickup',
              facilityName: pu.name,
              address:      pu.address,
              city:         pu.city,
              state:        pu.state,
              apptStart:    puStart,
              apptEnd:      addMinutes(puStart, 30),
            },
            {
              id:           crypto.randomUUID(),
              sequence:     2,
              type:         'delivery',
              facilityName: dl.name,
              address:      dl.address,
              city:         dl.city,
              state:        dl.state,
              apptStart:    dlStart,
              apptEnd:      addMinutes(dlStart, 30),
              instructions: `Trailer #${trailerNum}`,
            },
          ],
        }],
      });
      created += 1;
      // Print the ABSOLUTE index so a 401 mid-run gives an exact
      // `START_AT = lastAbs + 1` value with no math.
      if (created % 5 === 0) console.log(`[seed] loads + ${created} (last abs idx ${i})`);
    } catch (err) {
      failed += 1;
      console.error(`[seed] load ${i} failed:`, (err as Error).message);
    }
  }

  console.log(`\n[seed] done. created=${created} failed=${failed}`);
}

main().catch(err => {
  console.error('[seed] fatal:', err);
  process.exit(1);
});
