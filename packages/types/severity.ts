/**
 * Motive driver-performance-event severity derivation.
 *
 * Motive delivers the raw scoring metrics inside each event's payload
 * (`event_intensity.value` + `metadata.severity`), but Motive's own
 * severity buckets aren't consistently populated for hard_brake /
 * hard_accel / hard_corner. This module derives a normalized severity
 * so both the dispatch UI and the driver app can rank + visualize
 * events off the same math.
 *
 * The thresholds below are STARTING VALUES. Real coaching-quality
 * thresholds vary by fleet mix (LTL vs bulk vs OTR, terrain, load
 * weight). Curzon is an OTR reefer fleet — these numbers err on the
 * "actually severe" side so a run-of-the-mill brake at a red light
 * doesn't land as red.
 *
 * Adjustable via SEVERITY_THRESHOLDS below.
 */

// ── Types ──────────────────────────────────────────────────────────────

export type SeverityLevel = "low" | "moderate" | "severe";

export interface DerivedSeverity {
  /** Coarse bucket for coloring + filtering. */
  level:        SeverityLevel;
  /** 0-100 fill percentage — 0 = no severity (or missing data), 100 =
   *  at or above the severe threshold. Rendered as a bar meter. */
  score:        number;
  /** Human display for the number + unit. e.g. "12.2 mph/s" or "0.6s". */
  displayValue: string;
  /** Motive's name for the metric. e.g. "Braking Intensity" or
   *  "Avg. Time-To-Hit". Shown as the meter's label. */
  metricName:   string;
  /** True when a LOWER number is worse (tailgating time-to-hit). The
   *  bar UI can invert the fill direction if it wants a "closer to the
   *  right = worse" convention. */
  isInverted:   boolean;
}

/** Minimum shape the derivation needs. Full raw payload is a superset. */
export interface SeverityInput {
  event_intensity?: {
    name?:      string | null;
    value?:     number | null;
    unit_type?: string | null;
  } | null;
  metadata?: {
    severity?: string | null;
  } | null;
  /** Motive's pre-formatted display string ("-7.6 mph/s"). Fallback
   *  when event_intensity isn't populated. */
  intensity?: string | null;
}

// ── Per-event-type thresholds ──────────────────────────────────────────

/** Numeric thresholds. For each event type: at what value does the
 *  event cross into moderate vs severe. `inverted: true` flips the
 *  comparison for time-to-hit-style metrics (lower = worse). */
const SEVERITY_THRESHOLDS: Record<string, { moderate: number; severe: number; inverted: boolean; unitHint?: string }> = {
  // Braking Intensity — Motive scores this as an acceleration-magnitude
  // metric; typical range for on-highway trucks is 6–20. Panic-stop
  // territory in a loaded OTR reefer starts around 15 mph/s; below that
  // is firm-but-defensive. 12 was landing every mildly firm highway
  // brake as red — recalibrated 2026-07-10 based on Curzon fleet data.
  hard_brake:  { moderate: 8,   severe: 15,   inverted: false, unitHint: "mph/s" },
  hard_accel:  { moderate: 8,   severe: 15,   inverted: false, unitHint: "mph/s" },
  // Lateral acceleration in g. 0.35g feels aggressive; 0.55g is a
  // near-rollover for a loaded reefer.
  hard_corner: { moderate: 0.4, severe: 0.55, inverted: false, unitHint: "g" },
  // Time-to-hit in seconds — closer = worse. 1.0s is coaching-worthy;
  // 0.7s means the follow distance was measured in car lengths, not
  // seconds.
  tailgating:  { moderate: 1.0, severe: 0.7,  inverted: true,  unitHint: "s" },
};

/** Categorical event types that don't have a numeric event_intensity
 *  — severity comes from metadata.severity string when Motive sets it. */
const CATEGORICAL_EVENTS = new Set([
  "cell_phone", "phone_use", "distraction", "drowsiness",
  "seatbelt", "camera_obstruction", "driver_facing_cam_obstruction",
  "unsafe_lane_change", "forward_collision_warning", "stop_sign_violation",
]);

// ── Derivation ─────────────────────────────────────────────────────────

export function deriveSeverity(
  raw: SeverityInput | null | undefined,
  eventType: string,
): DerivedSeverity {
  const ei = raw?.event_intensity ?? null;
  const metricName = ei?.name?.trim() || motiveMetricFallback(eventType);
  const metaSeverity = raw?.metadata?.severity?.toLowerCase() ?? null;

  const thresholds = SEVERITY_THRESHOLDS[eventType];
  const numericValue = firstFiniteNumber(ei?.value, parseFirstNumber(raw?.intensity));

  // Numeric event: use per-type thresholds.
  if (thresholds && numericValue != null) {
    const level = classify(numericValue, thresholds);
    const score = scoreFor(numericValue, thresholds);
    return {
      level,
      score,
      displayValue: formatValue(numericValue, ei?.unit_type ?? thresholds.unitHint ?? null),
      metricName,
      isInverted:   thresholds.inverted,
    };
  }

  // Categorical event: rely on Motive's severity string when set.
  if (CATEGORICAL_EVENTS.has(eventType)) {
    if (metaSeverity === "high" || metaSeverity === "severe") {
      return { level: "severe",   score: 100, displayValue: "High",     metricName, isInverted: false };
    }
    if (metaSeverity === "medium" || metaSeverity === "moderate") {
      return { level: "moderate", score: 60,  displayValue: "Moderate", metricName, isInverted: false };
    }
    return { level: "moderate", score: 60, displayValue: "Flagged", metricName, isInverted: false };
  }

  // Unknown event type — fall through to Motive's own categorical
  // signal, then default to low. Never throws, never returns NaN.
  if (metaSeverity === "high" || metaSeverity === "severe") {
    return { level: "severe", score: 100, displayValue: "High", metricName, isInverted: false };
  }
  return {
    level: "low",
    score: 0,
    displayValue: numericValue != null
      ? formatValue(numericValue, ei?.unit_type ?? null)
      : (raw?.intensity ?? "—"),
    metricName,
    isInverted: false,
  };
}

// ── Classifiers ────────────────────────────────────────────────────────

function classify(value: number, t: { moderate: number; severe: number; inverted: boolean }): SeverityLevel {
  if (t.inverted) {
    if (value <= t.severe)   return "severe";
    if (value <= t.moderate) return "moderate";
    return "low";
  }
  if (value >= t.severe)   return "severe";
  if (value >= t.moderate) return "moderate";
  return "low";
}

/** Map value → 0-100 fill percentage. Below "moderate" scales 0-33,
 *  moderate→severe scales 33-100, at/above severe pins at 100.
 *  Inverted metrics (time-to-hit) mirror the same shape. */
function scoreFor(value: number, t: { moderate: number; severe: number; inverted: boolean }): number {
  if (t.inverted) {
    if (value >= t.moderate) {
      // Anywhere in the "safe" range — scale from 0 up to 33 as the
      // driver closes on the moderate cutoff.
      const safeAnchor = t.moderate * 2;
      const raw = ((safeAnchor - value) / (safeAnchor - t.moderate)) * 33;
      return clamp(raw, 0, 33);
    }
    if (value >= t.severe) {
      const raw = 33 + ((t.moderate - value) / (t.moderate - t.severe)) * 66;
      return clamp(raw, 33, 100);
    }
    return 100;
  }
  if (value <= t.moderate) {
    const raw = (value / t.moderate) * 33;
    return clamp(raw, 0, 33);
  }
  if (value <= t.severe) {
    const raw = 33 + ((value - t.moderate) / (t.severe - t.moderate)) * 66;
    return clamp(raw, 33, 100);
  }
  return 100;
}

// ── Formatting helpers ─────────────────────────────────────────────────

function formatValue(value: number, unitType: string | null): string {
  const abs = Math.abs(value);
  const rounded = abs >= 10 ? abs.toFixed(1) : abs.toFixed(2);
  const unit = normalizeUnit(unitType);
  return `${rounded}${unit ? ` ${unit}` : ""}`;
}

function normalizeUnit(unitType: string | null): string {
  if (!unitType) return "";
  const u = unitType.toLowerCase();
  // Motive's "acceleration" unit is confusingly labeled — the actual
  // numbers are in mph/s for brake/accel and g for corner. Prefer a
  // cleaner label for the driver-facing bar.
  if (u === "acceleration") return "mph/s";
  return u;
}

function parseFirstNumber(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.abs(Number(m[0]));
  return Number.isFinite(n) ? n : null;
}

function firstFiniteNumber(...candidates: Array<number | null | undefined>): number | null {
  for (const c of candidates) if (typeof c === "number" && Number.isFinite(c)) return Math.abs(c);
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function motiveMetricFallback(eventType: string): string {
  switch (eventType) {
    case "hard_brake":       return "Braking intensity";
    case "hard_accel":       return "Acceleration intensity";
    case "hard_corner":      return "Cornering intensity";
    case "tailgating":       return "Time to hit";
    case "cell_phone":       return "Phone use";
    case "distraction":      return "Distraction";
    case "drowsiness":       return "Drowsiness";
    case "seatbelt":         return "Seatbelt";
    default:                 return eventType.replace(/_/g, " ");
  }
}
