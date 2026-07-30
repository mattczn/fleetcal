/**
 * Paged PostgREST reads.
 *
 * PostgREST silently caps every response at 1000 rows. Not an error, not
 * a truncation flag — you just get 1000 back and a total that's quietly
 * wrong. Any query whose result set can exceed that has to page.
 *
 * `build` must return a FRESH query on each call; PostgREST query
 * builders are single-use.
 *
 * The `.order("id")` is load-bearing, not decoration: `.range()` without
 * a stable ORDER BY lets Postgres serve different pages from different
 * scan plans, so rows duplicate across pages and others never appear at
 * all. Callers may pass their own ordering for display — this helper
 * appends id as the final tiebreak, which is what makes the paging
 * deterministic.
 *
 * (routes/expenses.ts carries its own copy of this predating the lib —
 * same rationale, same guard.)
 */

const PAGE = 1000;

export async function fetchAllRows<T>(
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build()
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${label}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
    // Defensive stop. A caller that accidentally builds an unfiltered
    // query on a huge table would otherwise page forever; better to
    // return a large-but-bounded set than to hang the request.
    if (out.length >= 50_000) {
      console.warn(`[fetchAllRows] ${label}: hit the 50k safety cap`);
      break;
    }
  }
  return out;
}
