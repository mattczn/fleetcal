'use client';

/**
 * Client-side super-admin check via GET /api/admin/me.
 *
 * Returns `null` while loading (don't render the admin entry
 * point yet) and `boolean` once resolved. The endpoint fail-safes
 * to `{ isAdmin: false }` so a transient outage just hides the
 * UI rather than 500-ing.
 *
 * Cached at module scope so navigating between Settings panels
 * doesn't re-hit the API — the value never changes during a
 * session (the env-var allowlist only updates on deploy).
 */

import { useEffect, useState } from 'react';

let cached: { value: boolean | null; fetchedAt: number } | null = null;
// Re-fetch after 10 min to pick up an allowlist change without a
// hard reload. Cheap call (no DB, just an env-var check).
const TTL_MS = 10 * 60 * 1000;

export function useIsSuperAdmin(): boolean | null {
  const [value, setValue] = useState<boolean | null>(() => {
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.value;
    return null;
  });

  useEffect(() => {
    if (cached && Date.now() - cached.fetchedAt < TTL_MS && cached.value !== null) {
      setValue(cached.value);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/admin/me');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { isAdmin: boolean };
        cached = { value: data.isAdmin, fetchedAt: Date.now() };
        if (!cancelled) setValue(data.isAdmin);
      } catch {
        cached = { value: false, fetchedAt: Date.now() };
        if (!cancelled) setValue(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return value;
}
