/**
 * Tiny concurrency-limited parallel map. Used by the invoice batch
 * routes so 40 invoices don't process one at a time.
 *
 * Why inline instead of pulling in p-map: zero extra deps, the
 * implementation is 15 lines, and we only need this primitive in
 * the invoice pipeline today.
 *
 * Behavior:
 *   - Each input runs through `fn` with at most `concurrency` in flight.
 *   - Output array preserves INPUT ORDER (so callers can match results
 *     to their inputs by index without extra bookkeeping).
 *   - Errors in `fn` reject the entire call. Callers that want
 *     per-item error tolerance should catch inside `fn` and return an
 *     error-shaped result instead of throwing.
 */

export async function pMapWithLimit<T, R>(
  items:       readonly T[],
  concurrency: number,
  fn:          (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (concurrency < 1)    concurrency = 1;

  const out: R[] = new Array(items.length);
  let nextIdx = 0;

  // Spin up `concurrency` workers; each pulls the next index until
  // the list is exhausted. No queues, no chunks — finest-grained
  // load balancing without a real scheduler.
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIdx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });

  await Promise.all(workers);
  return out;
}
