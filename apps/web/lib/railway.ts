/**
 * Railway API client for the web app.
 *
 * Singleton pattern: a single `railway` instance is exported and used by
 * the store and components. Token retrieval is wired via
 * `setRailwayTokenProvider()` from a React component that has access to
 * Clerk's `useAuth()` (see RailwayClientProvider). Calls before the
 * provider is set get an unauthed request → 401.
 *
 * Env: `NEXT_PUBLIC_RAILWAY_URL` overrides the default production URL.
 * For local dev against `apps/api` running on :8080, set it to
 * `http://localhost:8080`.
 */

import type {
  CreateLoadRequest, CreateLoadResponse,
  ListLoadsResponse, GetLoadResponse,
  ListLoadSummariesResponse,
  SearchLoadsResponse,
  UpdateLoadRequest, UpdateLoadResponse,
  UpdateEventRequest, UpdateEventResponse,
  SplitRelayRequest, SplitRelayResponse,
  UnsplitRelayRequest, UnsplitRelayResponse,
  DeleteLoadResponse, RestoreLoadResponse,
  CreateEventRequest, CreateEventResponse,
  UpdateEventByIdRequest, UpdateEventByIdResponse,
  DeleteEventResponse,
  ReplaceStopsRequest, ReplaceStopsResponse,
  GetAuditLogResponse,
  LoadNotification, LoadNotificationKind,
  GetRateConUrlResponse,
  ListDocumentsResponse,
  GetDocumentUrlResponse,
  ListAssetsResponse, CreateAssetRequest, CreateAssetResponse,
  UpdateAssetRequest, UpdateAssetResponse, ReorderAssetsRequest,
  ListDriversResponse, CreateDriverRequest, CreateDriverResponse,
  UpdateDriverRequest, UpdateDriverResponse,
  ListCustomersResponse, CreateCustomerRequest, CreateCustomerResponse,
  UpdateCustomerRequest, UpdateCustomerResponse,
  RefreshCustomerInvoicingResponse,
  HarvestRateConFromPdfRequest,
  HarvestRateConFromPdfResponse,
  ListTrailersResponse, CreateTrailerRequest, CreateTrailerResponse,
  UpdateTrailerRequest, UpdateTrailerResponse,
  ListDispatchersResponse, CreateDispatcherRequest, CreateDispatcherResponse,
  UpdateDispatcherRequest, UpdateDispatcherResponse,
  ListDriverAssetPrefsResponse, SetDriverAssetPrefRequest, SetDriverAssetPrefResponse,
  ListSavedLocationsResponse, CreateSavedLocationRequest, CreateSavedLocationResponse,
  UpdateSavedLocationRequest, UpdateSavedLocationResponse,
  ListPayrollAdjustmentsResponse, CreatePayrollAdjustmentRequest, CreatePayrollAdjustmentResponse,
  ListPayrollRecordsResponse, UpsertPayrollRecordRequest, UpsertPayrollRecordResponse,
  GetOrgSettingsResponse, UpdateOrgSettingsRequest, UpdateOrgSettingsResponse,
  CreateInvoiceRequest, CreateInvoiceResponse,
  ListInvoicesResponse, GetInvoiceResponse,
  UpdateInvoiceRequest, UpdateInvoiceResponse,
  SendInvoiceRequest, SendInvoiceResponse,
  GenerateInvoicePacketResponse,
  BatchSendInvoicesRequest, BatchSendInvoicesResponse,
  BatchResendInvoicesRequest, BatchResendInvoicesResponse,
  BatchGenerateInvoicesRequest, BatchGenerateInvoicesResponse,
  MarkInvoicePaidRequest, MarkInvoicePaidResponse,
  VoidInvoiceRequest, VoidInvoiceResponse,
  ListCheckCallsResponse, CreateCheckCallRequest, CreateCheckCallResponse,
  GetEventResponse,
  ListRecentStopsResponse,
  ListFuelReportsResponse, ListFuelReportsQuery,
  UpdateFuelReportRequest, UpdateFuelReportResponse,
  ListFuelTransactionsRequest, ListFuelTransactionsResponse,
  MatchFuelTransactionRequest, MatchFuelTransactionResponse,
  AssignFuelTransactionRequest, AssignFuelTransactionResponse,
  SingleRowAutoMatchResponse,
  ListMaintenanceReportsQuery, ListMaintenanceReportsResponse,
  GetMaintenanceReportResponse,
  UpdateMaintenanceReportRequest, UpdateMaintenanceReportResponse,
  ConvertMaintenanceReportRequest, ConvertMaintenanceReportResponse,
  ListMaintenanceActionItemsQuery, ListMaintenanceActionItemsResponse,
  GetMaintenanceActionItemResponse,
  CreateMaintenanceActionItemRequest, CreateMaintenanceActionItemResponse,
  UpdateMaintenanceActionItemRequest, UpdateMaintenanceActionItemResponse,
  UploadMaintenanceActionItemPhotoResponse, DeleteMaintenanceActionItemPhotoResponse,
} from '@fleetcal/types';

const BASE_URL =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

let _getToken: (() => Promise<string | null>) | null = null;

/** Wired by RailwayClientProvider on Clerk auth state changes. */
export function setRailwayTokenProvider(fn: () => Promise<string | null>) {
  _getToken = fn;
}

/** Shape of one movement card returned by /v1/movements. Mirrors the
 *  API's response.byVehicle[vehicleId] entries. */
export interface MovementCard {
  id:             number;
  vehicleId:      number;
  vehicleNumber:  string | null;
  startTime:      string;
  endTime:        string | null;
  miles:          number | null;
  durationMin:    number | null;
  origin:         string | null;
  destination:    string | null;
  type:           string | null;
  status:         string | null;
  source:         number | null;
  originLat:      number | null;
  originLon:      number | null;
  destinationLat: number | null;
  destinationLon: number | null;
}

// ── Asset timeline (movements + links graph) ─────────────────────────
//
// Wire shapes for the new `/v1/timeline` endpoints. These are the
// canonical types for the asset-timeline page and any downstream
// agent that consumes movement-link facts.

export type TimelineMovementSource = "motive" | "manual" | "derived";
export type TimelineLinkRole = "loaded" | "transition" | "dwell" | "rest" | "unrelated";

export interface TimelineMovement {
  id:               string;
  assetId:          number;
  driverId?:        number;
  source:           TimelineMovementSource;
  motivePeriodId?:  number;
  startTime:        string;
  endTime?:         string;
  durationMin?:     number;
  miles?:           number;
  origin?:          string;
  destination?:     string;
  originLat?:       number;
  originLon?:       number;
  destinationLat?:  number;
  destinationLon?:  number;
  notes?:           string;
  createdBy:        string;
  createdAt:        string;
  updatedAt:        string;
}

export interface TimelineLink {
  id:               string;
  movementId:       string;
  role:             TimelineLinkRole;
  loadedEventId?:   string;
  fromEventId?:     string;
  toEventId?:       string;
  dwellStopId?:     string;
  source:           string;             // 'ai_v1' | 'manual' | 'rule_xxx'
  sourceUser?:      string;
  confidence?:      "high" | "medium" | "low";
  reasoning?:       string;
  assertedAt:       string;
}

export interface TimelineEvent {
  id:               string;
  title:            string | null;
  start:            string;
  end:              string;
  status:           string | null;
  eventKind:        string | null;
  nonRevenueType:   string | null;
  loadPrice:        number | null;
  /** Server-computed: linehaul + billable accessorials. Read-only. */
  totalBillable:    number | null;
  loadNum:          string | null;     // loads.load_num
  /** 'pickup' / 'delivery' for relay legs, null for whole loads. */
  relayRole:        'pickup' | 'delivery' | null;
  driverPay:        number | null;     // events.driver_pay
  loadedMiles:      number | null;     // events.loaded_miles (quoted)
  driverName:       string | null;
  stops: Array<{
    id:             string;
    sequence:       number;
    type:           string | null;
    facilityName:   string | null;
    address:        string | null;
    city:           string | null;
    state:          string | null;
    apptStart:      string | null;
    apptEnd:        string | null;
    lat:            number | null;
    lng:            number | null;
  }>;
}

// ── Profitability attribution (revenue/mile per load + day) ────────
// Inbound convention: deadhead miles credited to the load they're
// repositioning toward; end-of-day yard return = day overhead.
// See apps/api/src/routes/timeline.ts computeProfitability().

export interface TimelineProfitabilityLoad {
  eventId:          string;
  title:            string | null;
  revenue:          number;
  driverPay:        number;
  netToTruck:       number;
  loadedMiles:      number;
  inboundDhMiles:   number;
  attributedMiles:  number;
  dwellMin:         number;
  rpmLoaded:        number | null;
  rpmAllIn:         number | null;
  deadheadPct:      number | null;
  /** Present (0..1) only when this load is a relay leg and its revenue
   *  has been prorated by leg miles. NULL for non-relay loads. UI shows
   *  a "Prorated 60% of $1k" badge when this is set. */
  relayShare?:      number | null;
}

export interface TimelineProfitabilityDay {
  totalRevenue:       number;
  totalDriverPay:     number;
  netToTruck:         number;
  loadedMiles:        number;
  inboundDhMiles:     number;
  attributedMiles:    number;
  yardReturnMiles:    number;
  unattributedMiles:  number;
  totalMiles:         number;
  dayRpm:             number | null;
  dayRpmTotal:        number | null;
  deadheadPctOfDay:   number | null;
}

export interface TimelineProfitability {
  loads: TimelineProfitabilityLoad[];
  day:   TimelineProfitabilityDay;
}

// ── Week summary (per-day P&L rollup for the week strip) ──────────

export interface WeekDaySummary {
  dayKey:            string;
  totalRevenue:      number;
  totalDriverPay:    number;
  loadCount:         number;
  loadedMiles:       number;
  inboundDhMiles:    number;
  attributedMiles:   number;
  yardReturnMiles:   number;
  unattributedMiles: number;
  totalMiles:        number;
  dayRpm:            number | null;
  dayRpmTotal:       number | null;
  deadheadPctOfDay:  number | null;
}

export interface WeekSummary {
  weekStart: string;
  days:      WeekDaySummary[];
  weekTotal: WeekDaySummary;
}

// ── Fleet performance (per-asset comparison rollup) ─────────────────

export interface FleetAssetPerformance {
  assetId:              number;
  name:                 string;
  unit:                 string | null;
  color:                string;
  motiveLinked:         boolean;
  totalRevenue:         number;
  totalDriverPay:       number;
  netToTruck:           number;
  loadCount:            number;
  loadedMiles:          number;
  inboundDhMiles:       number;
  attributedMiles:      number;
  yardReturnMiles:      number;
  unattributedMiles:    number;
  totalMiles:           number;
  dayRpm:               number | null;
  dayRpmTotal:          number | null;
  deadheadPctOfDay:     number | null;
  avgRevPerLoad:        number | null;
  avgLoadedMilesPerLoad: number | null;
  driverPayPct:         number | null;
  utilization:          number | null;
  activeDays:           number;
  netPerMile:           number | null;
}

export interface FleetPerformanceResponse {
  windowFrom: string;
  windowTo:   string;
  assets:     FleetAssetPerformance[];
}

export interface TimelinePayload {
  asset:         { id: number; name: string; unit: string | null };
  windowFrom:    string;
  windowTo:      string;
  events:        TimelineEvent[];
  movements:     TimelineMovement[];
  links:         TimelineLink[];
  profitability: TimelineProfitability;
}

export interface CreateMovementRequest {
  assetId:         number;
  driverId?:       number;
  startTime:       string;
  endTime?:        string;
  durationMin?:    number;
  miles?:          number;
  origin?:         string;
  destination?:    string;
  originLat?:      number;
  originLon?:      number;
  destinationLat?: number;
  destinationLon?: number;
  notes?:          string;
}

export interface UpdateMovementRequest {
  startTime?:      string;
  endTime?:        string | null;
  durationMin?:    number | null;
  miles?:          number | null;
  origin?:         string | null;
  destination?:    string | null;
  originLat?:      number | null;
  originLon?:      number | null;
  destinationLat?: number | null;
  destinationLon?: number | null;
  notes?:          string | null;
}

export interface AssertLinkRequest {
  movementId:      string;
  role:            TimelineLinkRole;
  loadedEventId?:  string;
  fromEventId?:    string;
  toEventId?:      string;
  dwellStopId?:    string;
  source?:         string;            // defaults to 'manual'
  confidence?:     "high" | "medium" | "low";
  reasoning?:      string;
}

export interface CostAnalysisLoad {
  loadId:              string;
  loadLabel:           string;
  confidence:          'high' | 'medium' | 'low';
  matchedMovementIds:  number[];

  loadedMiles:         number;
  deadheadMilesBefore: number;
  deadheadMilesAfter:  number;

  loadedHours:         number;
  deadheadHoursBefore: number;
  deadheadHoursAfter:  number;

  /** Per-bucket time breakdown — newer reports include this so the
   *  UI can show "X hrs at shipper / Y hrs traveling / Z hrs at
   *  receiver" instead of the lumped loadedHours number. Optional so
   *  reports persisted before this field was added still parse. */
  timeAtShipperHours?:  number;
  timeTravelingHours?:  number;
  timeAtReceiverHours?: number;

  revenue:             number;
  driverPay:           number;
  marginAfterDriver:   number;

  statedRpm:           number;
  trueRpm:             number;
  statedRph:           number;
  trueRph:             number;
  marginRpm:           number;
  marginRph:           number;

  reasoning:           string;
}

export interface CostAnalysisUnmatched {
  movementId:    number;
  likelyPurpose: 'positioning' | 'return_home' | 'personal' | 'unknown';
  miles:         number;
  reasoning:     string;
}

export interface CostAnalysisResult {
  loads:              CostAnalysisLoad[];
  unmatchedMovements: CostAnalysisUnmatched[];
  summary: {
    totalRevenue:         number;
    totalDriverPay:       number;
    totalMargin:          number;
    totalLoadedMiles:     number;
    totalDeadheadMiles:   number;
    totalReturnHomeMiles: number;
    totalLoadedHours:     number;
    totalDeadheadHours:   number;
    fleetTrueRpm:         number;
    fleetTrueRph:         number;
    fleetMarginRpm:       number;
    fleetMarginRph:       number;
    loadedRatio:          number;
    narrative:            string;
  };
}

export interface MovementProbeSummary {
  httpStatus:               number | null;
  pagesFetched:             number;
  totalReturned:            number;
  uniqueVehicleIds:         number[];
  includesQueriedVehicle:   boolean;
  periodsForQueriedVehicle: number;
  assignedToDriver:         number;
  unassignedToDriver:       number;
  sampleForQueriedVehicle:  unknown[];
  firstRawSample:           unknown;
  firstUrl?:                string;
  error:                    string | null;
}

export class RailwayError extends Error {
  constructor(public status: number, public detail: unknown, message?: string) {
    super(message ?? `Railway request failed: ${status}`);
  }
}

class RailwayClient {
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    // First-paint auth race: if a component fires a request BEFORE
    // RailwayClientProvider's mount-time useEffect has registered the
    // token provider (this happens easily for early calendar /
    // dashboard fetches), the request would otherwise go out with no
    // Authorization header and 401. Poll briefly for the provider
    // before falling back — this turns a flaky "you have to hard-
    // refresh sometimes" symptom into a guaranteed authenticated
    // first call. 2s cap is generous; in practice the provider is
    // ready within 1-2 frames.
    if (!_getToken) {
      for (let i = 0; i < 20 && !_getToken; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
    const token = _getToken ? await _getToken() : null;
    // FormData bodies: let the browser set Content-Type (with boundary)
    // and pass through unchanged. JSON bodies get the explicit header
    // and are stringified.
    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const headers: Record<string, string> = {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    };
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined
        ? { body: isFormData ? (body as FormData) : JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) {
      // Read the body once — calling .json() consumes the stream even on
      // parse failure, so we can't fall through to .text() afterwards.
      const text = await res.text();
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* keep raw text */ }
      throw new RailwayError(res.status, detail, `${method} ${path} → ${res.status}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  /** Raw fetch — for endpoints that stream. Caller handles res.body. */
  async rawFetch(method: string, path: string, body?: unknown): Promise<Response> {
    const token = _getToken ? await _getToken() : null;
    return fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  // ── Loads ────────────────────────────────────────────────────────────
  createLoad(req: CreateLoadRequest)  { return this.req<CreateLoadResponse>('POST',   '/v1/loads', req); }
  listLoads(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return this.req<ListLoadsResponse>('GET', `/v1/loads${qs ? `?${qs}` : ''}`);
  }
  getLoad(id: string)                 { return this.req<GetLoadResponse>('GET',      `/v1/loads/${id}`); }

  /** Load-shaped report endpoint — one row per load (relays collapse).
   *  See packages/types/api.ts LoadSummary for the response shape. */
  listLoadSummaries(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return this.req<ListLoadSummariesResponse>('GET', `/v1/reports/loads${qs ? `?${qs}` : ''}`);
  }
  // ── Closeout / POD verification queue ─────────────────────────────────
  listCloseoutQueue(
    tab: 'pending' | 'recent' | 'flagged' | 'verified' | 'invoiced' | 'paid' | 'all' | 'released_all' = 'all',
    opts?: { limit?: number; offset?: number; q?: string; now?: string },
  ) {
    const params = new URLSearchParams({ tab });
    if (opts?.limit  != null) params.set('limit',  String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.q && opts.q.trim().length >= 2) params.set('q', opts.q.trim());
    // Naive ISO ("YYYY-MM-DDTHH:mm") in the org's dispatch zone. The
    // events.end column is stored as a naive text string in the same
    // format, so passing a UTC ISO produces wrong comparisons once
    // local time and UTC straddle midnight.
    if (opts?.now) params.set('now', opts.now);
    return this.req<{
      loads: import('@fleetcal/types').Load[];
      /** Per-loadId map of doc-kind counts: { [loadId]: { pod: 2, bol: 1, lumper: 1 } } */
      docCounts: Record<string, Record<string, number>>;
      /** Per-loadId relay partner info — the OTHER leg's driver + truck.
       *  Populated only for relay loads; lookup misses are normal for
       *  single-leg loads. The closeout table uses this to render
       *  "Driver A / + Driver B" without having to fetch the partner
       *  leg separately. */
      relayPartners?: Record<string, { driverName?: string; assetName?: string }>;
      /** Total matching rows across all pages (for pagination footer). */
      total: number;
      /** Sum of load prices across the full filtered set, deduped by
       *  loadId so relay loads count once. 0 on tabs where the API
       *  doesn't compute it (verified/invoiced/paid use DB pagination). */
      totalLoadValue?: number;
      limit: number;
      offset: number;
    }>('GET', `/v1/closeout/queue?${params.toString()}`);
  }
  updateLoadCloseout(id: string, body: {
    action:
      | 'verify'
      | 'flag'
      | 'clear_flag'
      | 'set_invoice_docs'
      | 'mark_invoiced'
      | 'mark_paid'
      | 'reopen'
      | 'set_priority'
      | 'clear_priority'
      | 'append_note'
      | 'add_follow_up';
    actorName?: string;
    flagReason?: 'missing_pod' | 'awaiting_rate_con' | 'detention_pending' | 'lumper_pending' | 'rate_mismatch' | 'other';
    flagNote?: string;
    invoiceDocIds?: string[];
    noteText?: string;
    followUpNote?: string;
    followUpCategory?: 'pod' | 'rate_con' | 'rate_dispute' | 'accessorial' | 'other';
    followUpResolution?: {
      type:           'accessorial_status' | 'flag_cleared' | 'mark_tonu';
      accessorialId?: string;
      newStatus?:     'approved' | 'denied';
      isTonu?:        boolean;
    };
  }) {
    return this.req<{ ok: true }>('PATCH', `/v1/closeout/loads/${id}`, body);
  }
  searchLoads(q: string, limit?: number) {
    const qs = new URLSearchParams({ q, ...(limit ? { limit: String(limit) } : {}) }).toString();
    return this.req<SearchLoadsResponse>('GET', `/v1/loads/search?${qs}`);
  }
  updateLoad(id: string, body: UpdateLoadRequest) {
    return this.req<UpdateLoadResponse>('PATCH', `/v1/loads/${id}`, body);
  }
  updateLoadEvent(loadId: string, eventId: string, body: UpdateEventRequest) {
    return this.req<UpdateEventResponse>('PATCH', `/v1/loads/${loadId}/events/${eventId}`, body);
  }
  splitRelay(loadId: string, body: SplitRelayRequest) {
    return this.req<SplitRelayResponse>('POST', `/v1/loads/${loadId}/split-relay`, body);
  }
  unsplitRelay(loadId: string, body: UnsplitRelayRequest) {
    return this.req<UnsplitRelayResponse>('POST', `/v1/loads/${loadId}/unsplit-relay`, body);
  }
  deleteLoad(id: string)              { return this.req<DeleteLoadResponse>('DELETE',  `/v1/loads/${id}`); }
  restoreLoad(id: string)             { return this.req<RestoreLoadResponse>('POST',   `/v1/loads/${id}/restore`); }

  // ── Events (non-revenue + load-id-agnostic ops) ──────────────────────
  createEvent(req: CreateEventRequest)            { return this.req<CreateEventResponse>('POST',     '/v1/events', req); }
  /** Fetch a single event by id, with its load + stops. Returns 1 entry
   *  for a single load, 2 entries for a relay (this leg + partner). */
  getEvent(id: string)                            { return this.req<GetEventResponse>('GET',        `/v1/events/${id}`); }
  updateEvent(id: string, body: UpdateEventByIdRequest) {
    return this.req<UpdateEventByIdResponse>('PATCH',   `/v1/events/${id}`, body);
  }
  deleteEvent(id: string)                         { return this.req<DeleteEventResponse>('DELETE',   `/v1/events/${id}`); }
  /** Soft-delete a revenue event row but leave the parent load
   *  intact. Used by the "Cancel & Remove from Calendar" flow. */
  cancelEventKeepLoad(id: string)                 { return this.req<DeleteEventResponse>('DELETE',   `/v1/events/${id}?keepLoad=true`); }
  replaceStops(eventId: string, body: ReplaceStopsRequest) {
    return this.req<ReplaceStopsResponse>('PUT',  `/v1/events/${eventId}/stops`, body);
  }
  getEventAuditLog(eventId: string) {
    return this.req<GetAuditLogResponse>('GET', `/v1/events/${eventId}/audit-log`);
  }
  // ── Notifications (dispatcher → driver nudges) ────────────────────────
  listEventNotifications(eventId: string) {
    return this.req<{ notifications: LoadNotification[] }>(
      'GET', `/v1/events/${eventId}/notifications`,
    );
  }
  sendEventNotification(eventId: string, body: { kind: LoadNotificationKind; sentByName: string }) {
    return this.req<{ notification: LoadNotification }>(
      'POST', `/v1/events/${eventId}/notify`, body,
    );
  }
  getRateConUrl(loadId: string) {
    return this.req<GetRateConUrlResponse>('GET', `/v1/loads/${loadId}/rate-con-url`);
  }
  listLoadDocuments(loadId: string) {
    return this.req<ListDocumentsResponse>('GET', `/v1/loads/${loadId}/documents`);
  }
  getDocumentUrl(documentId: string) {
    return this.req<GetDocumentUrlResponse>('GET', `/v1/documents/${documentId}/url`);
  }
  renameDocument(documentId: string, fileName: string) {
    return this.req<{ ok: true; fileName: string }>('PATCH', `/v1/documents/${documentId}`, { fileName });
  }
  /** Flip a doc's per-row invoice-include flag. null resets to the
   *  heuristic; true/false override it. Backs the dispatcher's
   *  Invoice toggle in the review queue. */
  updateDocumentInvoiceInclude(documentId: string, includedInInvoice: boolean | null) {
    return this.req<{ ok: true }>('PATCH', `/v1/documents/${documentId}`, { includedInInvoice });
  }
  /** Change a document's kind. When fileName is omitted, the server
   *  auto-renames the display fileName to match the new kind using
   *  the same {LOAD_NUM}_{KIND}{_N}.{ext} convention as upload. */
  updateDocumentKind(documentId: string, kind: import('@fleetcal/types').DocumentKind) {
    return this.req<{ ok: true; fileName?: string; kind?: string }>('PATCH', `/v1/documents/${documentId}`, { kind });
  }
  deleteDocument(documentId: string) {
    return this.req<{ ok: true }>('DELETE', `/v1/documents/${documentId}`);
  }
  /** Multipart upload — bypasses the JSON `req` helper because file
   *  bodies need FormData and a different Content-Type. */
  async uploadLoadDocument(loadId: string, file: File, kind: import('@fleetcal/types').DocumentKind) {
    const token = _getToken ? await _getToken() : null;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    const res = await fetch(`${BASE_URL}/v1/loads/${loadId}/documents`, {
      method: 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: fd,
    });
    if (!res.ok) {
      const text = await res.text();
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* keep raw text */ }
      throw new RailwayError(res.status, detail, `POST /v1/loads/${loadId}/documents → ${res.status}`);
    }
    return res.json() as Promise<{
      document: {
        id: string; loadId: string | null; fileName: string;
        mimeType?: string; sizeBytes?: number;
        kind: import('@fleetcal/types').DocumentKind; uploadedAt: string;
      };
    }>;
  }

  // ── Reference data ──────────────────────────────────────────────────
  listAssets()                               { return this.req<ListAssetsResponse>('GET', '/v1/assets'); }
  createAsset(body: CreateAssetRequest)      { return this.req<CreateAssetResponse>('POST', '/v1/assets', body); }
  updateAsset(id: number, body: UpdateAssetRequest) {
    return this.req<UpdateAssetResponse>('PATCH', `/v1/assets/${id}`, body);
  }
  deleteAsset(id: number)                    { return this.req<void>('DELETE', `/v1/assets/${id}`); }
  /** Hard delete — actually removes the row. 409 if any loads still
   *  reference this asset; in that case fall back to deleteAsset (retire). */
  hardDeleteAsset(id: number)                { return this.req<{ deleted: true; id: number }>('DELETE', `/v1/assets/${id}?hard=true`); }
  reorderAssets(ids: number[]) {
    return this.req<void>('POST', '/v1/assets/reorder', { ids } satisfies ReorderAssetsRequest);
  }

  listDrivers()                              { return this.req<ListDriversResponse>('GET', '/v1/drivers'); }
  createDriver(body: CreateDriverRequest)    { return this.req<CreateDriverResponse>('POST', '/v1/drivers', body); }
  updateDriver(id: number, body: UpdateDriverRequest) {
    return this.req<UpdateDriverResponse>('PATCH', `/v1/drivers/${id}`, body);
  }
  deleteDriver(id: number)                   { return this.req<void>('DELETE', `/v1/drivers/${id}`); }
  /** Hard delete — actually removes the row. 409 if any loads reference. */
  hardDeleteDriver(id: number)               { return this.req<{ deleted: true; id: number }>('DELETE', `/v1/drivers/${id}?hard=true`); }

  // Driver documents (ops surface)
  listDriverDocuments(driverId: number) {
    return this.req<{ documents: import('@fleetcal/types').DriverDocument[] }>(
      'GET', `/v1/drivers/${driverId}/documents`,
    );
  }
  uploadDriverDocument(driverId: number, form: FormData) {
    return this.req<{ document: import('@fleetcal/types').DriverDocument }>(
      'POST', `/v1/drivers/${driverId}/documents`, form,
    );
  }
  deleteDriverDocument(documentId: string) {
    return this.req<{ ok: true }>('DELETE', `/v1/driver-documents/${documentId}`);
  }
  getDriverDocumentUrl(documentId: string) {
    return this.req<{ url: string }>('GET', `/v1/driver-documents/${documentId}/url`);
  }

  // Asset (truck) documents — mirror of the driver-docs surface.
  listAssetDocuments(assetId: number) {
    return this.req<{ documents: import('@fleetcal/types').AssetDocument[] }>(
      'GET', `/v1/assets/${assetId}/documents`,
    );
  }
  uploadAssetDocument(assetId: number, form: FormData) {
    return this.req<{ document: import('@fleetcal/types').AssetDocument }>(
      'POST', `/v1/assets/${assetId}/documents`, form,
    );
  }
  deleteAssetDocument(documentId: string) {
    return this.req<{ ok: true }>('DELETE', `/v1/asset-documents/${documentId}`);
  }
  getAssetDocumentUrl(documentId: string) {
    return this.req<{ url: string }>('GET', `/v1/asset-documents/${documentId}/url`);
  }

  // Trailer documents — mirror of the driver-docs surface.
  listTrailerDocuments(trailerId: number) {
    return this.req<{ documents: import('@fleetcal/types').TrailerDocument[] }>(
      'GET', `/v1/trailers/${trailerId}/documents`,
    );
  }
  uploadTrailerDocument(trailerId: number, form: FormData) {
    return this.req<{ document: import('@fleetcal/types').TrailerDocument }>(
      'POST', `/v1/trailers/${trailerId}/documents`, form,
    );
  }
  deleteTrailerDocument(documentId: string) {
    return this.req<{ ok: true }>('DELETE', `/v1/trailer-documents/${documentId}`);
  }
  getTrailerDocumentUrl(documentId: string) {
    return this.req<{ url: string }>('GET', `/v1/trailer-documents/${documentId}/url`);
  }

  listCustomers()                            { return this.req<ListCustomersResponse>('GET', '/v1/customers'); }
  createCustomer(body: CreateCustomerRequest) { return this.req<CreateCustomerResponse>('POST', '/v1/customers', body); }
  updateCustomer(id: string, body: UpdateCustomerRequest) {
    return this.req<UpdateCustomerResponse>('PATCH', `/v1/customers/${id}`, body);
  }
  deleteCustomer(id: string)                 { return this.req<void>('DELETE', `/v1/customers/${id}`); }
  /** Re-runs the rate-con broker-harvest prompt against the customer's
   *  most recent rate confirmation and returns the four invoicing
   *  fields for the UI to pre-fill. Does NOT auto-write — caller is
   *  expected to drop the values into form state and let the existing
   *  Save (PATCH /v1/customers/:id) commit them. */
  refreshCustomerInvoicingFromRateCon(id: string) {
    return this.req<RefreshCustomerInvoicingResponse>('POST', `/v1/customers/${id}/refresh-invoicing-from-ratecon`, {});
  }
  /** Run the broker-harvest prompt against a PDF the caller already
   *  has in hand. Used by the new-customer review modal during the
   *  rate-con upload flow — the customer doesn't exist yet, so we
   *  send the bytes directly instead of going through the
   *  by-customer-id refresh path. */
  harvestRateConFromPdf(body: HarvestRateConFromPdfRequest) {
    return this.req<HarvestRateConFromPdfResponse>('POST', '/v1/customers/harvest-from-pdf', body);
  }

  listTrailers()                             { return this.req<ListTrailersResponse>('GET', '/v1/trailers'); }
  createTrailer(body: CreateTrailerRequest)  { return this.req<CreateTrailerResponse>('POST', '/v1/trailers', body); }
  updateTrailer(id: number, body: UpdateTrailerRequest) {
    return this.req<UpdateTrailerResponse>('PATCH', `/v1/trailers/${id}`, body);
  }
  deleteTrailer(id: number)                  { return this.req<void>('DELETE', `/v1/trailers/${id}`); }
  hardDeleteTrailer(id: number)              { return this.req<{ deleted: true; id: number }>('DELETE', `/v1/trailers/${id}?hard=true`); }

  listDispatchers()                          { return this.req<ListDispatchersResponse>('GET', '/v1/dispatchers'); }
  createDispatcher(body: CreateDispatcherRequest) { return this.req<CreateDispatcherResponse>('POST', '/v1/dispatchers', body); }
  updateDispatcher(id: string, body: UpdateDispatcherRequest) {
    return this.req<UpdateDispatcherResponse>('PATCH', `/v1/dispatchers/${id}`, body);
  }
  deleteDispatcher(id: string)               { return this.req<void>('DELETE', `/v1/dispatchers/${id}`); }

  listDriverAssetPrefs()                     { return this.req<ListDriverAssetPrefsResponse>('GET', '/v1/driver-asset-prefs'); }
  setDriverAssetPref(assetId: number, body: SetDriverAssetPrefRequest) {
    return this.req<SetDriverAssetPrefResponse>('PUT', `/v1/driver-asset-prefs/${assetId}`, body);
  }
  deleteDriverAssetPref(assetId: number)     { return this.req<void>('DELETE', `/v1/driver-asset-prefs/${assetId}`); }

  // ── Saved locations ──────────────────────────────────────────────────
  listSavedLocations()                       { return this.req<ListSavedLocationsResponse>('GET', '/v1/saved-locations'); }
  createSavedLocation(body: CreateSavedLocationRequest) {
    return this.req<CreateSavedLocationResponse>('POST', '/v1/saved-locations', body);
  }
  updateSavedLocation(id: string, body: UpdateSavedLocationRequest) {
    return this.req<UpdateSavedLocationResponse>('PATCH', `/v1/saved-locations/${id}`, body);
  }
  deleteSavedLocation(id: string)            { return this.req<void>('DELETE', `/v1/saved-locations/${id}`); }

  // ── Payroll ───────────────────────────────────────────────────────────
  listPayrollAdjustments(query: { weekStart?: string; driverName?: string } = {}) {
    const qs = new URLSearchParams();
    if (query.weekStart)  qs.set('weekStart',  query.weekStart);
    if (query.driverName) qs.set('driverName', query.driverName);
    const s = qs.toString();
    return this.req<ListPayrollAdjustmentsResponse>('GET', `/v1/payroll/adjustments${s ? `?${s}` : ''}`);
  }
  createPayrollAdjustment(body: CreatePayrollAdjustmentRequest) {
    return this.req<CreatePayrollAdjustmentResponse>('POST', '/v1/payroll/adjustments', body);
  }
  deletePayrollAdjustment(id: string)        { return this.req<void>('DELETE', `/v1/payroll/adjustments/${id}`); }

  /** Every filter is optional. Omitting them all returns every
   *  finalized record for the org. Use weekStartFrom/To to scope to
   *  a date range (server-side filter, much cheaper than fetching all
   *  and filtering client-side). */
  listPayrollRecords(query: {
    driverName?:    string;
    weekStart?:     string;
    weekStartFrom?: string;
    weekStartTo?:   string;
  } = {}) {
    const qs = new URLSearchParams();
    if (query.driverName)    qs.set('driverName',    query.driverName);
    if (query.weekStart)     qs.set('weekStart',     query.weekStart);
    if (query.weekStartFrom) qs.set('weekStartFrom', query.weekStartFrom);
    if (query.weekStartTo)   qs.set('weekStartTo',   query.weekStartTo);
    const s = qs.toString();
    return this.req<ListPayrollRecordsResponse>('GET', `/v1/payroll/records${s ? `?${s}` : ''}`);
  }
  upsertPayrollRecord(body: UpsertPayrollRecordRequest) {
    return this.req<UpsertPayrollRecordResponse>('POST', '/v1/payroll/records', body);
  }
  deletePayrollRecord(id: string)            { return this.req<void>('DELETE', `/v1/payroll/records/${id}`); }

  // ── Org settings ──────────────────────────────────────────────────────
  getOrgSettings()                           { return this.req<GetOrgSettingsResponse>('GET', '/v1/org-settings'); }
  updateOrgSettings(body: UpdateOrgSettingsRequest) {
    return this.req<UpdateOrgSettingsResponse>('PATCH', '/v1/org-settings', body);
  }

  // ── Asset timeline (movements + links graph) ──────────────────────────
  //
  // New source-agnostic movement system. Distinct from `/v1/movements`
  // below, which is the legacy Motive-only calendar feed kept around
  // for the existing calendar UI. New code should consume `/v1/timeline`.

  getAssetTimeline(assetId: number, from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return this.req<TimelinePayload>('GET', `/v1/timeline/assets/${assetId}?${qs.toString()}`);
  }
  createManualMovement(body: CreateMovementRequest) {
    return this.req<{ movement: TimelineMovement }>('POST', '/v1/timeline/movements', body);
  }
  updateManualMovement(id: string, body: UpdateMovementRequest) {
    return this.req<{ movement: TimelineMovement }>('PATCH', `/v1/timeline/movements/${id}`, body);
  }
  deleteManualMovement(id: string) {
    return this.req<{ ok: true }>('DELETE', `/v1/timeline/movements/${id}`);
  }
  assertMovementLink(body: AssertLinkRequest) {
    return this.req<{ link: TimelineLink }>('POST', '/v1/timeline/links', body);
  }
  clearMovementLink(movementId: string) {
    return this.req<{ link: TimelineLink }>('DELETE', `/v1/timeline/links/${movementId}`);
  }
  /** Runs Claude over every movement on the asset in [from, to] and
   *  writes link facts with source='ai_v1'. Skips movements whose
   *  current link source='manual' so dispatcher edits survive
   *  re-runs. Returns counts so the UI can show what landed. */
  autoLinkAssetTimeline(assetId: number, from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return this.req<{
      ok:             true;
      linksWritten:   number;
      manualSkipped:  number;
      totalMovements: number;
      proposedCount?: number;
      message?:       string;
    }>('POST', `/v1/timeline/assets/${assetId}/auto-link?${qs.toString()}`);
  }

  /** Per-day P&L summary for one asset across a 7-day window. Used
   *  by the timeline page's week strip to render a Sat-Fri row of
   *  load count / revenue / RPM cards without 7 timeline payload fetches. */
  getWeekSummary(assetId: number, weekStart: string, tz: string) {
    const qs = new URLSearchParams({ weekStart, tz });
    return this.req<WeekSummary>('GET', `/v1/timeline/assets/${assetId}/week-summary?${qs.toString()}`);
  }

  /** Per-asset performance rollup over an arbitrary window — feeds the
   *  /performance comparison table. Same inbound-attribution pipeline
   *  the timeline page uses, applied across every non-hidden asset. */
  getFleetPerformance(from: string, to: string, tz: string) {
    const qs = new URLSearchParams({ from, to, tz });
    return this.req<FleetPerformanceResponse>('GET', `/v1/fleet/performance?${qs.toString()}`);
  }

  // ── Movements (Motive driving-periods feed) ───────────────────────────
  /** Trigger a manual Motive sync. mode='backfill' pulls the last N
   *  days (default 7) for every vehicle; mode='incremental' advances
   *  the per-org cursor like the cron does. */
  syncMovements(body: { mode: 'backfill' | 'incremental'; windowDays?: number }) {
    return this.req<{ ok: true; result: { rowsUpserted: number; pagesFetched: number; durationMs: number } }>(
      'POST', '/v1/movements/sync', body,
    );
  }
  /** Calendar feed for the Movements column mode. from/to are ISO. */
  listMovements(from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return this.req<{ byVehicle: Record<string, MovementCard[]> }>(
      'GET', `/v1/movements?${qs.toString()}`,
    );
  }
  /** Fleet-wide ELD mileage in [from, to] — `max(odometer_miles) -
   *  min(...)` per asset that has motive_vehicle_id set, summed.
   *  Used by the dashboard Total Miles tile. */
  odometerSummary(from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return this.req<{
      totalMiles:    number;
      eldAssetCount: number;
      perAsset:      Record<string, number>;
    }>('GET', `/v1/movements/odometer-summary?${qs.toString()}`);
  }
  /** Time series of daily odometer snapshots for one vehicle. */
  listOdometer(vehicleId: string | number, from?: string, to?: string) {
    const qs = new URLSearchParams({ vehicleId: String(vehicleId) });
    if (from) qs.set("from", from);
    if (to)   qs.set("to", to);
    return this.req<{
      vehicleId: number;
      readings: Array<{
        captured_at:         string;
        located_at:          string | null;
        odometer_miles:      number | null;
        true_odometer_miles: number | null;
      }>;
    }>('GET', `/v1/movements/odometer?${qs.toString()}`);
  }
  /** Manually fire the daily odometer snapshot for this org. */
  snapshotOdometer() {
    return this.req<{ ok: true; result: { vehiclesSeen: number; rowsInserted: number; rowsSkipped: number } }>(
      'POST', '/v1/movements/odometer/snapshot', {},
    );
  }
  /** Latest saved cost-analysis report for a vehicle (or null). */
  getLatestCostAnalysis(vehicleId: string | number) {
    const qs = new URLSearchParams({ vehicleId: String(vehicleId) });
    return this.req<{
      report: {
        id:           string;
        window_from:  string;
        window_to:    string;
        result:       CostAnalysisResult;
        counts:       { movements: number; loads: number } | null;
        usage:        { inputTokens?: number; outputTokens?: number; cacheCreationTokens?: number | null; cacheReadTokens?: number | null } | null;
        model:        string;
        created_at:   string;
        created_by:   string | null;
      } | null;
    }>('GET', `/v1/cost-analysis/latest?${qs.toString()}`);
  }
  /** Run a fresh analysis and persist it. Returns the same shape as the
   *  saved row plus the analysis (so the caller can render immediately).
   *  Note: kept for backward compat; the chunked flow (analyzeLoad +
   *  saveCostAnalysis) is preferred for new code. */
  runCostAnalysis(vehicleId: string | number, from: string, to: string) {
    return this.req<{
      id:        string | null;
      createdAt: string | null;
      vehicleId: number;
      window:    { from: string; to: string };
      counts:    { movements: number; loads: number };
      analysis:  CostAnalysisResult;
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationTokens?: number | null;
        cacheReadTokens?: number | null;
      };
    }>('POST', '/v1/cost-analysis/run', { vehicleId, from, to });
  }
  /** List loads + movement count in the analysis window. Cheap, no AI.
   *  Frontend uses this to chunk the work for the parallel per-load flow. */
  listCostAnalysisLoads(vehicleId: string | number, from: string, to: string) {
    const qs = new URLSearchParams({ vehicleId: String(vehicleId), from, to });
    return this.req<{
      assetId: number | null;
      events: Array<{ id: string; title: string | null; start: string; end: string }>;
      movementsCount: number;
    }>('GET', `/v1/cost-analysis/loads-in-window?${qs.toString()}`);
  }
  /** Analyze ONE load. Backend pulls movements ±6h around the load's
   *  window, sends a small prompt to Claude, returns just the per-load
   *  shape. Fire in parallel for all loads in the analysis window. */
  analyzeCostLoad(vehicleId: string | number, eventId: string) {
    return this.req<{
      loadId: string;
      load:   Omit<CostAnalysisLoad, 'loadId'> & { loadId?: string };
      usage: {
        inputTokens?: number;
        outputTokens?: number;
        cacheCreationTokens?: number | null;
        cacheReadTokens?: number | null;
      };
    }>('POST', '/v1/cost-analysis/load', { vehicleId, eventId });
  }
  /** Save an assembled bundle (all per-load chunks merged + client-side
   *  summary) to cost_analysis_reports. */
  saveCostAnalysis(input: {
    vehicleId: string | number;
    from:      string;
    to:        string;
    assetId?:  number;
    result:    CostAnalysisResult;
    counts:    { movements: number; loads: number };
    usage?:    { inputTokens?: number; outputTokens?: number };
  }) {
    return this.req<{ id: string; createdAt: string }>('POST', '/v1/cost-analysis/save', input);
  }
  /** Per-vehicle completeness check: pulls Motive's driving_periods
   *  for [from, to) and compares to what's in our DB. */
  verifyMovements(from: string, to: string) {
    const qs = new URLSearchParams({ from, to });
    return this.req<{
      window: { from: string; to: string };
      pagesFetched: number;
      pagesCapAt: number;
      motiveError: string | null;
      summary: {
        motiveTotalRecords: number;
        motiveTotalMiles:   number;
        dbTotalRecords:     number;
        dbTotalMiles:       number;
        vehiclesInMotive:   number;
        vehiclesInDb:       number;
        okCount:            number;
        mismatchCount:      number;
      };
      rows: Array<{
        vehicleId:      number;
        motiveRecords:  number;
        motiveMiles:    number;
        dbRecords:      number;
        dbMiles:        number;
        recordDiff:     number;
        mileDiff:       number;
        ok:             boolean;
      }>;
    }>('GET', `/v1/movements/verify?${qs.toString()}`);
  }
  /** Debug helper — probes both Motive endpoints (driver-attributed
   *  driving_periods AND unidentified_driving_events) for one vehicle
   *  and reports back what Motive's API actually has. */
  debugMovements(vehicleId: string | number, days = 14) {
    const qs = new URLSearchParams({ vehicleId: String(vehicleId), days: String(days) });
    return this.req<{
      queriedVehicleId: number;
      queriedDays: number;
      queriedStartTime: string;
      pagesCapAt: number;
      drivingPeriods:      MovementProbeSummary;
      unidentifiedDriving: MovementProbeSummary;
      db: { rowsForQueriedVehicle: number; assignedRowsInWindow: number; eligibleRowsInWindow: number; sample: unknown[] };
    }>('GET', `/v1/movements/debug?${qs.toString()}`);
  }

  // ── Invoices ──────────────────────────────────────────────────────────
  createInvoice(body: CreateInvoiceRequest) {
    return this.req<CreateInvoiceResponse>('POST', '/v1/invoices', body);
  }
  listInvoices(query: { status?: string; loadId?: string; brokerId?: string; from?: string; to?: string } = {}) {
    const qs = new URLSearchParams();
    if (query.status)   qs.set('status',   query.status);
    if (query.loadId)   qs.set('loadId',   query.loadId);
    if (query.brokerId) qs.set('brokerId', query.brokerId);
    if (query.from)     qs.set('from',     query.from);
    if (query.to)       qs.set('to',       query.to);
    const s = qs.toString();
    return this.req<ListInvoicesResponse>('GET', `/v1/invoices${s ? `?${s}` : ''}`);
  }
  getInvoice(id: string) {
    return this.req<GetInvoiceResponse>('GET', `/v1/invoices/${id}`);
  }
  updateInvoice(id: string, body: UpdateInvoiceRequest) {
    return this.req<UpdateInvoiceResponse>('PATCH', `/v1/invoices/${id}`, body);
  }
  sendInvoice(id: string, body: SendInvoiceRequest) {
    return this.req<SendInvoiceResponse>('POST', `/v1/invoices/${id}/send`, body);
  }
  generateInvoicePacket(id: string) {
    return this.req<GenerateInvoicePacketResponse>('POST', `/v1/invoices/${id}/packet`);
  }
  batchSendInvoices(body: BatchSendInvoicesRequest) {
    return this.req<BatchSendInvoicesResponse>('POST', '/v1/invoices/batch-send', body);
  }
  /** Resend one or more already-sent invoices. Same one-email-per-invoice
   *  flow as batch-send; refreshes sent_at on each. */
  batchResendInvoices(body: BatchResendInvoicesRequest) {
    return this.req<BatchResendInvoicesResponse>('POST', '/v1/invoices/batch-resend', body);
  }
  batchGenerateInvoices(body: BatchGenerateInvoicesRequest) {
    return this.req<BatchGenerateInvoicesResponse>('POST', '/v1/invoices/batch-generate', body);
  }
  markInvoicePaid(id: string, body: MarkInvoicePaidRequest = {}) {
    return this.req<MarkInvoicePaidResponse>('POST', `/v1/invoices/${id}/mark-paid`, body);
  }
  voidInvoice(id: string, body: VoidInvoiceRequest = {}) {
    return this.req<VoidInvoiceResponse>('POST', `/v1/invoices/${id}/void`, body);
  }
  /**
   * Void the existing draft + create a fresh invoice with current load
   * data. Same body shape as createInvoice (all fields optional —
   * invoice_number carries through by default). Refuses to act on
   * sent/paid/void invoices server-side. Returns the new invoice in
   * the same response shape as createInvoice.
   */
  regenerateInvoice(id: string, body: Partial<CreateInvoiceRequest> = {}) {
    return this.req<CreateInvoiceResponse>('POST', `/v1/invoices/${id}/regenerate`, body);
  }
  /**
   * Fetch the rendered invoice PDF as a Blob. Uses authed fetch under
   * the hood; callers turn the Blob into either a download link or
   * an object URL for inline viewing.
   */
  async getInvoicePdfBlob(id: string, opts: { asDownload?: boolean } = {}): Promise<Blob> {
    const qs = opts.asDownload ? '?download=1' : '';
    const res = await this.rawFetch('GET', `/v1/invoices/${id}/pdf${qs}`);
    if (!res.ok) {
      const text = await res.text();
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* keep raw */ }
      throw new RailwayError(res.status, detail, `GET /v1/invoices/${id}/pdf → ${res.status}`);
    }
    return res.blob();
  }
  /**
   * Fetch the merged invoice-packet PDF (invoice + rate con + POD + ...)
   * as a Blob. This is the canonical broker-facing artifact — what
   * gets attached when an email is sent. Use this for any preview /
   * download where you want the full bundle, not just the invoice.
   */
  async getInvoicePacketBlob(id: string, opts: { asDownload?: boolean } = {}): Promise<Blob> {
    const qs = opts.asDownload ? '?download=1' : '';
    const res = await this.rawFetch('GET', `/v1/invoices/${id}/packet.pdf${qs}`);
    if (!res.ok) {
      const text = await res.text();
      let detail: unknown = text;
      try { detail = JSON.parse(text); } catch { /* keep raw */ }
      throw new RailwayError(res.status, detail, `GET /v1/invoices/${id}/packet.pdf → ${res.status}`);
    }
    return res.blob();
  }

  // ── Stops ─────────────────────────────────────────────────────────────
  listRecentStops(query: { q: string; limit?: number }) {
    const qs = new URLSearchParams({ q: query.q });
    if (query.limit != null) qs.set('limit', String(query.limit));
    return this.req<ListRecentStopsResponse>('GET', `/v1/stops/recent?${qs.toString()}`);
  }

  // ── Check calls ───────────────────────────────────────────────────────
  listCheckCalls(loadId: string) {
    return this.req<ListCheckCallsResponse>('GET', `/v1/loads/${loadId}/check-calls`);
  }
  createCheckCall(loadId: string, body: CreateCheckCallRequest) {
    return this.req<CreateCheckCallResponse>('POST', `/v1/loads/${loadId}/check-calls`, body);
  }
  deleteCheckCall(id: string) {
    return this.req<void>('DELETE', `/v1/check-calls/${id}`);
  }

  // ── Fuel reports ──────────────────────────────────────────────────────
  listFuelReports(query: ListFuelReportsQuery = {}) {
    const qs = new URLSearchParams();
    if (query.from)        qs.set('from',        query.from);
    if (query.to)          qs.set('to',          query.to);
    if (query.driverId)    qs.set('driverId',    String(query.driverId));
    if (query.assetId)     qs.set('assetId',     String(query.assetId));
    if (query.matchStatus) qs.set('matchStatus', query.matchStatus);
    if (query.limit)       qs.set('limit',       String(query.limit));
    if (query.offset)      qs.set('offset',      String(query.offset));
    const s = qs.toString();
    return this.req<ListFuelReportsResponse>('GET', `/v1/fuel-reports${s ? `?${s}` : ''}`);
  }
  updateFuelReport(id: string, body: UpdateFuelReportRequest) {
    return this.req<UpdateFuelReportResponse>('PATCH', `/v1/fuel-reports/${id}`, body);
  }
  deleteFuelReport(id: string) {
    return this.req<void>('DELETE', `/v1/fuel-reports/${id}`);
  }

  // ── Fuel transactions (card-side, Mudflap emails) ─────────────────────
  listFuelTransactions(query: ListFuelTransactionsRequest = {}) {
    const qs = new URLSearchParams();
    if (query.matchStatus) qs.set('matchStatus', query.matchStatus);
    if (query.from)        qs.set('from',        query.from);
    if (query.to)          qs.set('to',          query.to);
    if (query.q)           qs.set('q',           query.q);
    if (query.limit  != null) qs.set('limit',  String(query.limit));
    if (query.offset != null) qs.set('offset', String(query.offset));
    const s = qs.toString();
    return this.req<ListFuelTransactionsResponse>('GET', `/v1/fuel-transactions${s ? `?${s}` : ''}`);
  }
  matchFuelTransaction(id: string, body: MatchFuelTransactionRequest) {
    return this.req<MatchFuelTransactionResponse>('PATCH', `/v1/fuel-transactions/${id}/match`, body);
  }
  /** Assign driver + truck directly on a card transaction, independent
   *  of any driver fuel_report. When body.applyToSimilar is true the
   *  server also updates every other unmatched transaction with the
   *  same driver_name in this org. */
  assignFuelTransaction(id: string, body: AssignFuelTransactionRequest) {
    return this.req<AssignFuelTransactionResponse>('PATCH', `/v1/fuel-transactions/${id}/assign`, body);
  }
  /** Run the auto-matcher against just this transaction. Same logic
   *  as the sweep but returns focused feedback ("matched" / "unmatched"
   *  / "already_matched") so the detail panel can react to the
   *  specific row. */
  autoMatchFuelTransaction(id: string) {
    return this.req<SingleRowAutoMatchResponse>('POST', `/v1/fuel-transactions/${id}/auto-match`);
  }
  /** Force a fresh auto-match pass over unmatched fuel transactions
   *  in the past 24h. Returns this org's scanned + matched counts.
   *  The server also runs this every 15 min on its own. */
  runFuelAutoMatchSweep() {
    return this.req<{ scanned: number; matched: number }>('POST', `/v1/fuel-transactions/auto-match-sweep`);
  }

  // ── Inspection reports (DVIRs) ──────────────────────────────────────
  listInspectionReports(query: {
    assetId?: number; trailerId?: number; driverId?: number;
    from?: string; to?: string; defectsOnly?: boolean;
    limit?: number; offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    if (query.assetId)    qs.set('assetId',    String(query.assetId));
    if (query.trailerId)  qs.set('trailerId',  String(query.trailerId));
    if (query.driverId)   qs.set('driverId',   String(query.driverId));
    if (query.from)       qs.set('from',       query.from);
    if (query.to)         qs.set('to',         query.to);
    if (query.defectsOnly) qs.set('defectsOnly', 'true');
    if (query.limit)      qs.set('limit',      String(query.limit));
    if (query.offset)     qs.set('offset',     String(query.offset));
    const s = qs.toString();
    return this.req<{
      inspections: Array<{
        id: string;
        driverId: number;
        driverName: string;
        assetId: number | null;
        assetName: string | null;
        trailerId: number | null;
        trailerName: string | null;
        inspectionDate: string;
        hasDefects: boolean;
        defectCount: number;
        itemCount: number;
        photoCount: number;
        durationSeconds: number | null;
        submittedAt: string;
        signedBy: string;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>('GET', `/v1/inspection-reports${s ? `?${s}` : ''}`);
  }
  getInspectionReport(id: string) {
    return this.req<{
      inspection: {
        id: string;
        driverId: number;
        driver: { name: string | null; phone: string | null } | null;
        assetId: number | null;
        asset:   { name: string | null; unit: string | null; type: string | null } | null;
        trailerId: number | null;
        trailer: { name: string | null; trailer_number: string | null } | null;
        inspectionDate: string;
        items:        Array<{ id: string; section: string; label: string; status: 'pass'|'fail'|'na'; notes?: string }>;
        trailerItems: Array<{ id: string; section: string; label: string; status: 'pass'|'fail'|'na'; notes?: string }>;
        notes: string | null;
        hasDefects: boolean;
        signedBy: string;
        submittedAt: string;
        durationSeconds: number | null;
        locationLat: number | null;
        locationLon: number | null;
        photos: Array<{
          id: string;
          itemId: string | null;
          target: 'truck' | 'trailer' | null;
          caption: string | null;
          signedUrl: string | null;
          uploadedAt: string;
        }>;
      };
    }>('GET', `/v1/inspection-reports/${id}`);
  }

  // ── Maintenance reports ───────────────────────────────────────────────
  listMaintenanceReports(query: ListMaintenanceReportsQuery = {}) {
    const qs = new URLSearchParams();
    if (query.status)    qs.set('status',    query.status);
    if (query.assetId)   qs.set('assetId',   String(query.assetId));
    if (query.trailerId) qs.set('trailerId', String(query.trailerId));
    if (query.driverId)  qs.set('driverId',  String(query.driverId));
    if (query.from)      qs.set('from',      query.from);
    if (query.to)        qs.set('to',        query.to);
    if (query.limit)     qs.set('limit',     String(query.limit));
    if (query.offset)    qs.set('offset',    String(query.offset));
    const s = qs.toString();
    return this.req<ListMaintenanceReportsResponse>('GET', `/v1/maintenance-reports${s ? `?${s}` : ''}`);
  }
  getMaintenanceReport(id: string) {
    return this.req<GetMaintenanceReportResponse>('GET', `/v1/maintenance-reports/${id}`);
  }
  updateMaintenanceReport(id: string, body: UpdateMaintenanceReportRequest) {
    return this.req<UpdateMaintenanceReportResponse>('PATCH', `/v1/maintenance-reports/${id}`, body);
  }
  convertMaintenanceReport(id: string, body: ConvertMaintenanceReportRequest = {}) {
    return this.req<ConvertMaintenanceReportResponse>('POST', `/v1/maintenance-reports/${id}/convert`, body);
  }
  deleteMaintenanceReport(id: string) {
    return this.req<void>('DELETE', `/v1/maintenance-reports/${id}`);
  }

  // ── Maintenance action items ─────────────────────────────────────────
  listMaintenanceActionItems(query: ListMaintenanceActionItemsQuery = {}) {
    const qs = new URLSearchParams();
    if (query.status)       qs.set('status',       query.status);
    if (query.priority)     qs.set('priority',     query.priority);
    if (query.category)     qs.set('category',     query.category);
    if (query.outOfService != null) qs.set('outOfService', String(query.outOfService));
    if (query.assetId)      qs.set('assetId',      String(query.assetId));
    if (query.trailerId)    qs.set('trailerId',    String(query.trailerId));
    if (query.scheduledFrom) qs.set('scheduledFrom', query.scheduledFrom);
    if (query.scheduledTo)   qs.set('scheduledTo',   query.scheduledTo);
    if (query.eventId)       qs.set('eventId',       query.eventId);
    if (query.limit)        qs.set('limit',        String(query.limit));
    if (query.offset)       qs.set('offset',       String(query.offset));
    const s = qs.toString();
    return this.req<ListMaintenanceActionItemsResponse>('GET', `/v1/maintenance-action-items${s ? `?${s}` : ''}`);
  }
  getMaintenanceActionItem(id: string) {
    return this.req<GetMaintenanceActionItemResponse>('GET', `/v1/maintenance-action-items/${id}`);
  }
  createMaintenanceActionItem(body: CreateMaintenanceActionItemRequest) {
    return this.req<CreateMaintenanceActionItemResponse>('POST', '/v1/maintenance-action-items', body);
  }
  updateMaintenanceActionItem(id: string, body: UpdateMaintenanceActionItemRequest) {
    return this.req<UpdateMaintenanceActionItemResponse>('PATCH', `/v1/maintenance-action-items/${id}`, body);
  }
  deleteMaintenanceActionItem(id: string) {
    return this.req<void>('DELETE', `/v1/maintenance-action-items/${id}`);
  }
  /** Multipart upload — one photo per call. Browser sets the
   *  Content-Type with the boundary; req() detects FormData and
   *  skips its default JSON Content-Type header. */
  uploadMaintenanceActionItemPhoto(actionItemId: string, file: File) {
    const fd = new FormData();
    fd.append('file', file);
    return this.req<UploadMaintenanceActionItemPhotoResponse>(
      'POST',
      `/v1/maintenance-action-items/${actionItemId}/photos`,
      fd,
    );
  }
  deleteMaintenanceActionItemPhoto(photoId: string) {
    return this.req<DeleteMaintenanceActionItemPhotoResponse>(
      'DELETE',
      `/v1/maintenance-action-items/photos/${photoId}`,
    );
  }
}

export const railway = new RailwayClient();
