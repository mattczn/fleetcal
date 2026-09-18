/**
 * Planned events (module: planning) on FleetCal Go.
 *
 * Plans are dispatcher placeholders that live in their own table and
 * endpoint (see apps/api/src/routes/planned-events.ts). On the calendar
 * they ride along in each truck's load list as tagged Load-shaped rows
 * so the three existing layouts (day blocks, schedule, timeline) place
 * them without a parallel positioning path; every card checks
 * `plannedOf(load)` and renders the dashed plan style + opens the plan
 * sheet instead of the load screen.
 */
import { useQuery } from "@tanstack/react-query";
import type { PlannedEvent } from "@fleetcal/types";
import type { Load } from "./types";
import { railway } from "./railway";
import { usePermissions } from "./usePermissions";

export const PLANNED_QUERY_KEY = "planned-events";

/** Open plans for the org. Empty (never throws) when the module is off
 *  or the role can't see plans — the API's 403 is the real gate. */
export function usePlannedEvents(orgId: string | undefined) {
  const { can } = usePermissions();
  const allowed = can("planning.access");
  return useQuery({
    queryKey: [PLANNED_QUERY_KEY, orgId],
    queryFn:  async () => {
      try {
        const { plannedEvents } = await railway.listPlannedEvents();
        return plannedEvents;
      } catch {
        return [] as PlannedEvent[];
      }
    },
    enabled:   !!orgId && allowed,
    staleTime: 30 * 1000,
  });
}

type PlannedRow = Load & { __planned: PlannedEvent };

/** Wrap a plan as a Load-shaped row for the calendar layouts. Only the
 *  fields the layouts read are meaningful; cards branch on plannedOf()
 *  before touching anything load-specific. */
export function planToRow(p: PlannedEvent): Load {
  const row = {
    id:         `plan:${p.id}`,
    assetId:    p.assetId,
    title:      p.title,
    start:      p.start,
    end:        p.end,
    driverName: p.driverName,
    status:     "scheduled",
    __planned:  p,
  };
  return row as unknown as Load;
}

export function plannedOf(load: Load): PlannedEvent | null {
  return (load as Partial<PlannedRow>).__planned ?? null;
}
