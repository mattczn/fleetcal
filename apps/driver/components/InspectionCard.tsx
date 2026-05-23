/**
 * InspectionCard — the daily-inspection prompt at the top of the
 * driver's Active loads tab. Two states only:
 *
 *   - RED   (no inspection submitted today)  → "Complete today's inspection"
 *   - GREEN (at least one done today)        → list of completed inspections
 *                                               + "Run another inspection"
 *
 * Defects do NOT shift the card to amber/yellow — done is done, the
 * color is binary. Defect counts surface as plain text below the
 * headline so dispatch still sees them, but the driver isn't punished
 * with a "warning" color for being honest on the form. (Earlier
 * iteration had a three-state design — green / amber / red — and the
 * user explicitly asked for the simpler binary because amber implied
 * "something wrong with this submission" rather than "issues reported
 * on the truck, which is what the form is for.")
 */
import React from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { Check, ClipboardCheck, Plus, AlertTriangle, AlertCircle } from "lucide-react-native";
import type { TodayInspectionSummary } from "@/lib/railway";

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
  onStart:      () => void;
}

export default function InspectionCard({ loading, inspections, onStart }: Props) {
  if (loading) {
    return (
      <View style={cardBase}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ActivityIndicator size="small" color="#6b7280" />
          <Text style={[txt(500), { color: "#6b7280", fontSize: 13 }]}>Checking today&apos;s inspections…</Text>
        </View>
      </View>
    );
  }

  const completed = inspections.length;

  // ── State A: nothing today → red prompt ──────────────────────────
  if (completed === 0) {
    return (
      <TouchableOpacity onPress={onStart} activeOpacity={0.85} style={[cardBase, {
        backgroundColor: "#fef2f2",
        borderColor: "#fecaca",
      }]}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center",
          }}>
            <AlertTriangle size={18} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[txt(700), { fontSize: 16, color: "#7f1d1d" }]}>
              Complete today&apos;s inspection
            </Text>
            <Text style={[txt(500), { fontSize: 13, color: "#991b1b", marginTop: 2 }]}>
              Required before your first run.
            </Text>
          </View>
          <View style={{
            paddingHorizontal: 14, paddingVertical: 9, borderRadius: 999,
            backgroundColor: "#dc2626",
          }}>
            <Text style={[txt(700), { color: "white", fontSize: 13 }]}>Start</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  // ── State B: at least one done → green summary + run another ─────
  // Always green. Defect count surfaces as text underneath; it doesn't
  // shift the card color.
  const defectCount = inspections.reduce(
    (n, ins) => n + (ins.has_defects ? 1 : 0),
    0,
  );
  return (
    <View style={[cardBase, {
      backgroundColor: "#f0fdf4",
      borderColor:     "#bbf7d0",
    }]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: "#16a34a",
          alignItems: "center", justifyContent: "center",
        }}>
          <Check size={20} color="white" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[txt(700), { fontSize: 16, color: "#14532d" }]}>
            {completed > 1 ? `Inspected today (${completed})` : "Inspected today"}
          </Text>
          <Text style={[txt(500), { fontSize: 13, color: "#166534", marginTop: 2 }]}>
            {summarize(inspections)}
          </Text>
          {defectCount > 0 && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
              <AlertCircle size={12} color="#374151" />
              <Text style={[txt(600), { fontSize: 12, color: "#374151" }]}>
                {defectCount} defect{defectCount === 1 ? "" : "s"} reported
              </Text>
            </View>
          )}
        </View>
      </View>
      <TouchableOpacity onPress={onStart} style={{
        flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start",
        marginTop: 10, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
        backgroundColor: "white", borderWidth: 1, borderColor: "#bbf7d0",
      }}>
        <Plus size={12} color="#166534" />
        <Text style={[txt(700), { fontSize: 12, color: "#166534" }]}>
          Run another inspection
        </Text>
      </TouchableOpacity>
      {/* If multiple, list each compactly below */}
      {completed > 1 && (
        <View style={{ marginTop: 10, gap: 4 }}>
          {inspections.map(ins => (
            <View key={ins.id} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <ClipboardCheck size={11} color="#166534" />
              <Text style={[txt(500), { fontSize: 11, color: "#14532d" }]}>
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
