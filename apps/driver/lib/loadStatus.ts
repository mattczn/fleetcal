const CONFIRMATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export function needsConfirmation(load: { status: string; start?: string }): boolean {
  if (load.status !== "scheduled") return false;
  if (!load.start) return false;
  const startMs = Date.parse(load.start.replace(" ", "T"));
  if (isNaN(startMs)) return false;
  return startMs - Date.now() <= CONFIRMATION_WINDOW_MS;
}

/**
 * Does this load still need the driver's run-confirmation? Mirrors the
 * green "Confirm Load" banner on the load-detail screen: any pre-trip
 * load (scheduled OR assigned) the driver hasn't confirmed yet that
 * isn't a non-revenue move. Used by BOTH the detail banner and the
 * loads-list caution chip so the two never disagree — change the rule
 * here and both surfaces follow.
 *
 * Distinct from `needsConfirmation` above, which is the legacy 12h-out
 * scheduling gate still used by the schedule day view's stripe.
 */
export function needsRunConfirmation(load: {
  status: string;
  confirmedAt?: string;
  eventKind?: string;
}): boolean {
  return (
    (load.status === "scheduled" || load.status === "assigned") &&
    !load.confirmedAt &&
    load.eventKind !== "non_revenue"
  );
}
