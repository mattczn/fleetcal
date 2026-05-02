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
  UpdateLoadRequest, UpdateLoadResponse,
  UpdateEventRequest, UpdateEventResponse,
  SplitRelayRequest, SplitRelayResponse,
  DeleteLoadResponse, RestoreLoadResponse,
  CreateEventRequest, CreateEventResponse,
  UpdateEventByIdRequest, UpdateEventByIdResponse,
  DeleteEventResponse,
  ReplaceStopsRequest, ReplaceStopsResponse,
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
      let detail: unknown;
      try { detail = await res.json(); } catch { detail = await res.text(); }
      throw new RailwayError(res.status, detail, `${method} ${path} → ${res.status}`);
    }
    if (res.status === 204) return undefined as unknown as T;
    return res.json() as Promise<T>;
  }

  // ── Loads ────────────────────────────────────────────────────────────
  createLoad(req: CreateLoadRequest)  { return this.req<CreateLoadResponse>('POST',   '/v1/loads', req); }
  listLoads(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return this.req<ListLoadsResponse>('GET', `/v1/loads${qs ? `?${qs}` : ''}`);
  }
  getLoad(id: string)                 { return this.req<GetLoadResponse>('GET',      `/v1/loads/${id}`); }
  updateLoad(id: string, body: UpdateLoadRequest) {
    return this.req<UpdateLoadResponse>('PATCH', `/v1/loads/${id}`, body);
  }
  updateLoadEvent(loadId: string, eventId: string, body: UpdateEventRequest) {
    return this.req<UpdateEventResponse>('PATCH', `/v1/loads/${loadId}/events/${eventId}`, body);
  }
  splitRelay(loadId: string, body: SplitRelayRequest) {
    return this.req<SplitRelayResponse>('POST', `/v1/loads/${loadId}/split-relay`, body);
  }
  deleteLoad(id: string)              { return this.req<DeleteLoadResponse>('DELETE',  `/v1/loads/${id}`); }
  restoreLoad(id: string)             { return this.req<RestoreLoadResponse>('POST',   `/v1/loads/${id}/restore`); }

  // ── Events (non-revenue + load-id-agnostic ops) ──────────────────────
  createEvent(req: CreateEventRequest)            { return this.req<CreateEventResponse>('POST',     '/v1/events', req); }
  updateEvent(id: string, body: UpdateEventByIdRequest) {
    return this.req<UpdateEventByIdResponse>('PATCH',   `/v1/events/${id}`, body);
  }
  deleteEvent(id: string)                         { return this.req<DeleteEventResponse>('DELETE',   `/v1/events/${id}`); }
  replaceStops(eventId: string, body: ReplaceStopsRequest) {
    return this.req<ReplaceStopsResponse>('PUT',  `/v1/events/${eventId}/stops`, body);
  }
}

export const railway = new RailwayClient();
