const CONFIRMATION_WINDOW_MS = 12 * 60 * 60 * 1000;

export function needsConfirmation(load: { status: string; start?: string }): boolean {
  if (load.status !== "scheduled") return false;
  if (!load.start) return false;
  const startMs = Date.parse(load.start.replace(" ", "T"));
  if (isNaN(startMs)) return false;
  return startMs - Date.now() <= CONFIRMATION_WINDOW_MS;
}
