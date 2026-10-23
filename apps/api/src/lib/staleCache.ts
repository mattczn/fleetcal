/**
 * Per-org results that are slow to build (half a year of loads): served
 * from memory, rebuilt in the background once older than freshMs (the stale
 * copy answers meanwhile), and dropped after maxMs. invalidate() starts a
 * rebuild right away, for writes the result depends on (areas, lane pay).
 * In-process, so it assumes a single API replica.
 */

interface Entry<T> { at: number; value: Promise<T>; refreshing: boolean }

export function staleCache<T>(build: (orgId: string) => Promise<T>, freshMs: number, maxMs: number) {
  const entries = new Map<string, Entry<T>>();
  const start = (orgId: string): Entry<T> => {
    const entry: Entry<T> = { at: Date.now(), value: build(orgId), refreshing: false };
    entries.set(orgId, entry);
    entry.value.catch(() => { if (entries.get(orgId) === entry) entries.delete(orgId); });
    return entry;
  };
  return {
    get(orgId: string, opts: { fresh?: boolean } = {}): Promise<T> {
      const e = entries.get(orgId);
      const age = e ? Date.now() - e.at : Infinity;
      if (!e || opts.fresh || age > maxMs) return start(orgId).value;
      if (age > freshMs && !e.refreshing) {
        e.refreshing = true;
        const next = build(orgId);
        next.then(
          () => { if (entries.get(orgId) === e) entries.set(orgId, { at: Date.now(), value: next, refreshing: false }); },
          () => { e.refreshing = false; },
        );
      }
      return e.value;
    },
    invalidate(orgId: string): void {
      if (entries.has(orgId)) start(orgId).value.catch(() => undefined);
    },
  };
}
