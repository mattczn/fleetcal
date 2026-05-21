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
  BatchGenerateInvoicesRequest, BatchGenerateInvoicesResponse,
  MarkInvoicePaidRequest, MarkInvoicePaidResponse,
  VoidInvoiceRequest, VoidInvoiceResponse,
  ListCheckCallsResponse, CreateCheckCallRequest, CreateCheckCallResponse,
  GetEventResponse,
  ListRecentStopsResponse,
  ListFuelReportsResponse, ListFuelReportsQuery,
  UpdateFuelReportRequest, UpdateFuelReportResponse,
  ListMaintenanceReportsQuery, ListMaintenanceReportsResponse,
  GetMaintenanceReportResponse,
  UpdateMaintenanceReportRequest, UpdateMaintenanceReportResponse,
  ConvertMaintenanceReportRequest, ConvertMaintenanceReportResponse,
  ListMaintenanceActionItemsQuery, ListMaintenanceActionItemsResponse,
  GetMaintenanceActionItemResponse,
  CreateMaintenanceActionItemRequest, CreateMaintenanceActionItemResponse,
  UpdateMaintenanceActionItemRequest, UpdateMaintenanceActionItemResponse,
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
    tab: 'pending' | 'flagged' | 'verified' | 'invoiced' | 'paid' | 'all' = 'pending',
    opts?: { limit?: number; offset?: number; q?: string },
  ) {
    const params = new URLSearchParams({ tab });
    if (opts?.limit  != null) params.set('limit',  String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    if (opts?.q && opts.q.trim().length >= 2) params.set('q', opts.q.trim());
    return this.req<{
      loads: import('@fleetcal/types').Load[];
      /** Per-loadId map of doc-kind counts: { [loadId]: { pod: 2, bol: 1, lumper: 1 } } */
      docCounts: Record<string, Record<string, number>>;
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
  reorderAssets(ids: number[]) {
    return this.req<void>('POST', '/v1/assets/reorder', { ids } satisfies ReorderAssetsRequest);
  }

  listDrivers()                              { return this.req<ListDriversResponse>('GET', '/v1/drivers'); }
  createDriver(body: CreateDriverRequest)    { return this.req<CreateDriverResponse>('POST', '/v1/drivers', body); }
  updateDriver(id: number, body: UpdateDriverRequest) {
    return this.req<UpdateDriverResponse>('PATCH', `/v1/drivers/${id}`, body);
  }
  deleteDriver(id: number)                   { return this.req<void>('DELETE', `/v1/drivers/${id}`); }

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

  listCustomers()                            { return this.req<ListCustomersResponse>('GET', '/v1/customers'); }
  createCustomer(body: CreateCustomerRequest) { return this.req<CreateCustomerResponse>('POST', '/v1/customers', body); }
  updateCustomer(id: string, body: UpdateCustomerRequest) {
    return this.req<UpdateCustomerResponse>('PATCH', `/v1/customers/${id}`, body);
  }
  deleteCustomer(id: string)                 { return this.req<void>('DELETE', `/v1/customers/${id}`); }

  listTrailers()                             { return this.req<ListTrailersResponse>('GET', '/v1/trailers'); }
  createTrailer(body: CreateTrailerRequest)  { return this.req<CreateTrailerResponse>('POST', '/v1/trailers', body); }
  updateTrailer(id: number, body: UpdateTrailerRequest) {
    return this.req<UpdateTrailerResponse>('PATCH', `/v1/trailers/${id}`, body);
  }
  deleteTrailer(id: number)                  { return this.req<void>('DELETE', `/v1/trailers/${id}`); }

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

  listPayrollRecords(query: { driverName: string; weekStart?: string }) {
    const qs = new URLSearchParams({ driverName: query.driverName });
    if (query.weekStart) qs.set('weekStart', query.weekStart);
    return this.req<ListPayrollRecordsResponse>('GET', `/v1/payroll/records?${qs.toString()}`);
  }
  upsertPayrollRecord(body: UpsertPayrollRecordRequest) {
    return this.req<UpsertPayrollRecordResponse>('POST', '/v1/payroll/records', body);
  }
  deletePayrollRecord(id: string)            { return this.req<void>('DELETE', `/v1/payroll/records/${id}`); }

  // ── Org settings ──────────────────────────────────────────────────────
  getOrgSettings()                           { return this.req<GetOrgSettingsResponse>('GET', '/v1/org-settings'); }
  /** Org-scoped recent-notifications log for the dispatcher bell.
   *  Window defaults to 48 hours on the server; pass `hours` to override. */
  listOrgNotifications(opts?: { hours?: number; limit?: number }) {
    const qs = new URLSearchParams();
    if (opts?.hours != null) qs.set('hours', String(opts.hours));
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    const q = qs.toString();
    return this.req<import('@fleetcal/types').ListOrgNotificationsResponse>('GET', `/v1/notifications${q ? `?${q}` : ''}`);
  }
  updateOrgSettings(body: UpdateOrgSettingsRequest) {
    return this.req<UpdateOrgSettingsResponse>('PATCH', '/v1/org-settings', body);
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
}

export const railway = new RailwayClient();
