/**
 * Railway API contract types — request and response shapes for endpoints
 * that the frontends call.
 *
 * Naming convention:
 *   <Verb><Entity>Request   — POST/PATCH bodies
 *   <Action>Response        — successful response payload
 *
 * Group related types under section headers; keep this file alphabetized
 * within each section as endpoints accumulate.
 */

// ── /v1/health ──────────────────────────────────────────────────────────

export interface HealthResponse {
  ok: true;
  service: "fleetcal-api";
  version: string;
  timestamp: string;
}
