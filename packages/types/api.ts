/**
 * Railway API contract types — request and response shapes for endpoints
 * that all three frontends call.
 *
 * Empty for now. As Railway endpoints come online (Phase 3), each one gets
 * its request/response pair declared here so the client and server share a
 * single source of truth. Convention:
 *
 *   export type SomeActionRequest  = { ... };
 *   export type SomeActionResponse = { ... };
 *
 * Group related shapes under a namespace if a single endpoint has many
 * related types. Keep this file boring — it's the API surface, not where
 * domain logic lives.
 */

export {};
