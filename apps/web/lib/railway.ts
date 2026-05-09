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
  ListCheckCallsResponse, CreateCheckCallRequest, CreateCheckCallResponse,
  GetEventResponse,
  ListRecentStopsResponse,
} from '@fleetcal/types';

const BASE_URL =
  process.env.NEXT_PUBLIC_RAILWAY_URL ?? 'https://fleetcalapi-production.up.railway.app';

let _getToken: (() => Promise<string | null>) | null = null;

/** Wired by RailwayClientProvider on Clerk auth state changes. */
export function setRailwayTokenProvider(fn: () => Promise<string | null>) {
  _getToken = fn;
}

export class RailwayError extends Error {
  constructor(public status: number, public detail: unknown, message?: string) {
    super(message ?? `Railway request failed: ${status}`);
  }
}

class RailwayClient {
  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = _getToken ? await _getToken() : null;
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  // ── Closeout / POD verification queue ─────────────────────────────────
  listCloseoutQueue(
    tab: 'pending' | 'flagged' | 'verified' | 'invoiced' | 'paid' | 'all' = 'pending',
    opts?: { limit?: number; offset?: number },
  ) {
    const params = new URLSearchParams({ tab });
    if (opts?.limit  != null) params.set('limit',  String(opts.limit));
    if (opts?.offset != null) params.set('offset', String(opts.offset));
    return this.req<{
      loads: import('@fleetcal/types').Load[];
      /** Per-loadId map of doc-kind counts: { [loadId]: { pod: 2, bol: 1, lumper: 1 } } */
      docCounts: Record<string, Record<string, number>>;
      /** Total matching rows across all pages (for pagination footer). */
      total: number;
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
      | 'append_note';
    actorName?: string;
    flagReason?: 'missing_pod' | 'awaiting_rate_con' | 'detention_pending' | 'lumper_pending' | 'rate_mismatch' | 'other';
    flagNote?: string;
    invoiceDocIds?: string[];
    noteText?: string;
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
  replaceStops(eventId: string, body: ReplaceStopsRequest) {
    return this.req<ReplaceStopsResponse>('PUT',  `/v1/events/${eventId}/stops`, body);
  }
  getEventAuditLog(eventId: string) {
    return this.req<GetAuditLogResponse>('GET', `/v1/events/${eventId}/audit-log`);
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
  updateOrgSettings(body: UpdateOrgSettingsRequest) {
    return this.req<UpdateOrgSettingsResponse>('PATCH', '/v1/org-settings', body);
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
}

export const railway = new RailwayClient();
