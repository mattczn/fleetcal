/**
 * InspectionCard — the daily-inspection prompt at the top of the
 * driver's Active loads tab.
 *
 * Two shapes, chosen by `truckHistoryEnabled`:
 *
 *   1. Truck-History OFF (default): the original single binary card —
 *        RED   (no inspection today)  → "Complete today's inspection"
 *        GREEN (at least one done)     → summary + "Run another inspection"
 *      Done is done; the color is binary, defects surface as text.
 *
 *   2. Truck-History ON (Curzon): TWO equal halves — "Pre-Trip" | "Post-Trip".
 *      Each half is tappable and launches the 3-step flow with that kind.
 *      A half turns GREEN once THIS driver has done THAT kind today (per
 *      driver, per day — computed from todaysInspections() matching the
 *      kind), and stays tappable so the driver can run another.
 */
import React from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { Check, ClipboardCheck, Plus, AlertTriangle, AlertCircle, Sun, Moon } from "lucide-react-native";
import type { TodayInspectionSummary } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

interface Props {
  loading:      boolean;
  inspections:  TodayInspectionSummary[];
  /** Opens the inspection flow for the given kind. Defaults to pre-trip
   *  when called with no argument (the Start / Run-another buttons). */
  onStart:      (kind?: "pre_trip" | "post_trip") => void;
  /** Curzon-only Truck History module — when on, renders the two-half
   *  Pre-Trip / Post-Trip card instead of the single binary one. */
  truckHistoryEnabled?: boolean;
}

export default function InspectionCard({ loading, inspections, onStart, truckHistoryEnabled = false }: Props) {
  const { C } = useTheme();
  if (loading) {
    return (
      <View style={[cardBase, { borderColor: C.border }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color={C.t3} />
          <Text style={[txt(500), { color: C.t3, fontSize: 13 }]}>Checking today&apos;s inspections…</Text>
        </View>
      </View>
    );
  }

  // ── Truck-History ON: two equal halves, each green per-driver-per-day ──
  if (truckHistoryEnabled) return <TwoHalfCard inspections={inspections} onStart={onStart} />;

  // ── Truck-History OFF: original single binary card ────────────────────
  return <BinaryCard inspections={inspections} onStart={onStart} />;
}

// ─── Truck-History: two-half Pre-Trip | Post-Trip card ────────────────

/** Today's date in the driver's local zone, as YYYY-MM-DD, to match a
 *  summary's inspection_date. Server stamps inspection_date on the row;
 *  a half is green iff there's a same-kind row dated today. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function doneToday(inspections: TodayInspectionSummary[], kind: "pre_trip" | "post_trip"): boolean {
  const today = localToday();
  // todaysInspections() is already day-scoped server-side; the date guard
  // is belt-and-suspenders against a stale cache spanning midnight.
  return inspections.some(i => i.kind === kind && (!i.inspection_date || i.inspection_date === today));
}

function TwoHalfCard({ inspections, onStart }: { inspections: TodayInspectionSummary[]; onStart: (kind: "pre_trip" | "post_trip") => void }) {
  const preDone  = doneToday(inspections, "pre_trip");
  const postDone = doneToday(inspections, "post_trip");
  return (
    <View style={[cardBase, { padding: 0, borderWidth: 0, overflow: "hidden", flexDirection: "row" }]}>
      <HalfCard
        kind="pre_trip"
        title="Pre-Trip"
        subtitle="Inspection"
        Icon={Sun}
        done={preDone}
        onPress={() => onStart("pre_trip")}
      />
      <HalfCard
        kind="post_trip"
        title="Post-Trip"
        subtitle="Inspection"
        Icon={Moon}
        done={postDone}
        onPress={() => onStart("post_trip")}
      />
    </View>
  );
}

function HalfCard({
  title, subtitle, Icon, done, onPress,
}: {
  kind: "pre_trip" | "post_trip";
  title: string;
  subtitle: string;
  Icon: React.ComponentType<{ size?: number; color?: string }>;
  done: boolean;
  onPress: () => void;
}) {
  const { C } = useTheme();
  const bg     = done ? C.greenBg  : C.redBg;
  const border = done ? C.green    : C.red;
  const ink    = done ? C.greenInk : C.redInk;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.85}
      style={{
        flex: 1, backgroundColor: bg, borderWidth: 1, borderColor: border,
        padding: 14, minHeight: 96, justifyContent: "space-between",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <View style={{
          width: 30, height: 30, borderRadius: 15,
          backgroundColor: done ? C.green : C.red,
          alignItems: "center", justifyContent: "center",
        }}>
          {done ? <Check size={17} color="white" /> : <Icon size={16} color="white" />}
        </View>
        {done && (
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: C.surface }}>
            <Text style={[txt(700), { fontSize: 10, color: ink }]}>Done today</Text>
          </View>
        )}
      </View>
      <View style={{ marginTop: 10 }}>
        <Text style={[txt(800), { fontSize: 16, color: ink }]}>{title}</Text>
        <Text style={[txt(500), { fontSize: 12, color: ink, marginTop: 1 }]}>{subtitle}</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Original single binary card (Truck-History OFF) ──────────────────

function BinaryCard({ inspections, onStart }: { inspections: TodayInspectionSummary[]; onStart: (kind?: "pre_trip" | "post_trip") => void }) {
  const { C } = useTheme();
  const completed = inspections.length;

  // State A: nothing today → red prompt.
  if (completed === 0) {
    return (
      <View style={[cardBase, { backgroundColor: C.redBg, borderColor: C.red }]}>
        <TouchableOpacity onPress={() => onStart("pre_trip")} activeOpacity={0.85}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: C.red, alignItems: "center", justifyContent: "center",
            }}>
              <AlertTriangle size={18} color="white" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[txt(700), { fontSize: 16, color: C.redInk }]}>
                Complete today&apos;s inspection
              </Text>
              <Text style={[txt(500), { fontSize: 13, color: C.redInk, marginTop: 2 }]}>
                Required before your first run.
              </Text>
            </View>
            <View style={{
              paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
              backgroundColor: C.red,
            }}>
              <Text style={[txt(700), { color: "white", fontSize: 13 }]}>Start</Text>
            </View>
          </View>
        </TouchableOpacity>
      </View>
    );
  }

  // State B: at least one done → green summary + run another. Always green.
  const defectCount = inspections.reduce((n, ins) => n + (ins.has_defects ? 1 : 0), 0);
  return (
    <View style={[cardBase, { backgroundColor: C.greenBg, borderColor: C.green }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: C.green, alignItems: "center", justifyContent: "center",
        }}>
          <Check size={20} color="white" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[txt(700), { fontSize: 16, color: C.greenInk }]}>
            {completed > 1 ? `Inspected today (${completed})` : "Inspected today"}
          </Text>
          <Text style={[txt(500), { fontSize: 13, color: C.greenInk, marginTop: 2 }]}>
            {summarize(inspections)}
          </Text>
          {defectCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
              <AlertCircle size={12} color={C.t2} />
              <Text style={[txt(600), { fontSize: 12, color: C.t2 }]}>
                {defectCount} defect{defectCount === 1 ? "" : "s"} reported
              </Text>
            </View>
          )}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
        <TouchableOpacity onPress={() => onStart("pre_trip")} style={{
          flexDirection: "row", alignItems: "center", gap: 6,
          paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
          backgroundColor: C.surface, borderWidth: 1, borderColor: C.green,
        }}>
          <Plus size={12} color={C.greenInk} />
          <Text style={[txt(700), { fontSize: 12, color: C.greenInk }]}>
            Run another inspection
          </Text>
        </TouchableOpacity>
      </View>
      {completed > 1 && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {inspections.map(ins => (
            <View key={ins.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <ClipboardCheck size={11} color={C.greenInk} />
              <Text style={[txt(500), { fontSize: 11, color: C.greenInk }]}>
                {labelFor(ins)} · {fmtTime(ins.submitted_at)}
                {ins.has_defects ? " · defects" : ""}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

// marginTop sits flush against the tab bar (which already has its own
// paddingBottom on the active-indicator), so only a couple px of
// breathing room. marginBottom separates the card from the first
// LoadCard so they don't read as one stacked block.
const cardBase = {
  marginHorizontal: 14,
  marginTop:        6,
  marginBottom:     14,
  borderRadius:     12,
  borderWidth:      1,
  padding:          16,
};

function summarize(list: TodayInspectionSummary[]): string {
  if (list.length === 1) {
    const i = list[0];
    return `${labelFor(i)} · ${fmtTime(i.submitted_at)}`;
  }
  return `Most recent: ${labelFor(list[0])} · ${fmtTime(list[0].submitted_at)}`;
}

// Equipment display rule per user: always prefix with the equipment
// type word so an inspection line reads as "Truck Big Red #312 +
// Trailer #5567" instead of "Big Red #312 + 5567" (which was easy to
// misread because a trailer's name field is often just its number).
function labelFor(i: TodayInspectionSummary): string {
  const truck   = i.asset   ? truckLabel(i.asset.name, i.asset.unit)              : "";
  const trailer = i.trailer ? trailerLabel(i.trailer.name, i.trailer.trailer_number) : "";
  if (truck && trailer) return `${truck} + ${trailer}`;
  return truck || trailer || "Inspection";
}

function truckLabel(name: string, unit: string | null | undefined): string {
  return `Truck ${name}${unit ? ` #${unit}` : ""}`;
}

function trailerLabel(name: string, trailerNumber: string | null | undefined): string {
  // Trailer numbers are the natural identifier for a trailer (the
  // name field is often just the number repeated). Prefer the number
  // and fall back to the name only if no number is set.
  if (trailerNumber) return `Trailer #${trailerNumber}`;
  return `Trailer ${name}`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
