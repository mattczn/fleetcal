/**
 * InspectionFormScreen — the daily DVIR (Driver Vehicle Inspection
 * Report) form. Drivers tap "Complete today's inspection" on the
 * schedule tab, this screen mounts, they pick truck (+ optional
 * trailer), tap through the checklist, optionally add notes/photos
 * per failed item, and submit.
 *
 * Drivers can submit more than once a day — used when they swap
 * equipment mid-day. The schedule-tab card surfaces the count.
 *
 * Photos are intentionally not implemented in this v1 (per user spec
 * "photos always optional"). The data model + schema both support
 * inspection_photos already; wiring them up later is just the UI +
 * the upload helper from the existing maintenance form.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from "react-native";
import { Truck, Container, ChevronDown, Check, X, ArrowLeft, AlertTriangle } from "lucide-react-native";
import { railway, type InspectionItemPayload } from "@/lib/railway";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

interface AssetOption   { id: number; name: string; unit?: string; }
interface TrailerOption { id: number; name: string; trailerNumber?: string; }

// ── Checklist definitions ─────────────────────────────────────────────
// Grouped by section, mirrored on UI. Keep this list lean — the goal
// is "compliance present" not "exhaustive walkaround". Drivers who
// skip 30 items every day stop trusting the form.

interface ChecklistItem { id: string; section: string; label: string; }

const TRUCK_CHECKLIST: ChecklistItem[] = [
  // Brakes
  { id: "brakes_service",  section: "Brakes", label: "Service brakes" },
  { id: "brakes_parking",  section: "Brakes", label: "Parking brake" },
  { id: "brakes_air",      section: "Brakes", label: "Air system / leaks" },

  // Lights
  { id: "lights_head",     section: "Lights", label: "Headlights" },
  { id: "lights_signals",  section: "Lights", label: "Turn signals / brake / hazard" },
  { id: "lights_marker",   section: "Lights", label: "Marker / reflectors" },

  // Tires & wheels
  { id: "tires_truck",     section: "Tires & wheels", label: "Tires (tread, pressure, damage)" },
  { id: "wheels_truck",    section: "Tires & wheels", label: "Wheels & rims" },

  // Steering & suspension
  { id: "steering",        section: "Steering & suspension", label: "Steering free play" },
  { id: "suspension",      section: "Steering & suspension", label: "Suspension / leaf springs" },

  // Engine & exhaust
  { id: "engine",          section: "Engine", label: "Engine / oil / coolant" },
  { id: "exhaust",         section: "Engine", label: "Exhaust system" },

  // Cab
  { id: "mirrors",         section: "Cab", label: "Mirrors" },
  { id: "wipers",          section: "Cab", label: "Windshield / wipers" },
  { id: "horn",            section: "Cab", label: "Horn" },

  // Emergency equipment
  { id: "extinguisher",    section: "Emergency", label: "Fire extinguisher" },
  { id: "triangles",       section: "Emergency", label: "Warning triangles / flares" },
];

const TRAILER_CHECKLIST: ChecklistItem[] = [
  { id: "coupling_5th",    section: "Coupling",       label: "Fifth wheel / kingpin" },
  { id: "coupling_air",    section: "Coupling",       label: "Air & electrical lines" },
  { id: "landing_gear",    section: "Coupling",       label: "Landing gear" },
  { id: "trailer_brakes",  section: "Trailer brakes", label: "Brake connections" },
  { id: "trailer_lights",  section: "Trailer lights", label: "Lights & reflectors" },
  { id: "trailer_tires",   section: "Trailer tires",  label: "Tires" },
  { id: "trailer_wheels",  section: "Trailer tires",  label: "Wheels & rims" },
  { id: "trailer_doors",   section: "Trailer body",   label: "Doors / latches" },
  { id: "trailer_floor",   section: "Trailer body",   label: "Floor / walls" },
  { id: "trailer_roof",    section: "Trailer body",   label: "Roof / tarp (if applicable)" },
];

type ItemStatus = "pass" | "fail" | "na";
type ItemState  = { status: ItemStatus | null; notes?: string };

interface Props {
  /** Initial asset to select. Defaults to the driver's currently
   *  assigned truck if known; null means "show picker open." */
  initialAssetId?: number | null;
  /** Driver's display name — used as the digital signature. */
  driverName:     string;
  onClose:        () => void;
  onSubmitted:    () => void;
}

export default function InspectionFormScreen({ initialAssetId, driverName, onClose, onSubmitted }: Props) {
  // ── Equipment selection ───────────────────────────────────────────
  const [assets,        setAssets]        = useState<AssetOption[]>([]);
  const [trailers,      setTrailers]      = useState<TrailerOption[]>([]);
  const [assetId,       setAssetId]       = useState<number | null>(initialAssetId ?? null);
  const [trailerId,     setTrailerId]     = useState<number | null>(null);
  const [pickerOpen,    setPickerOpen]    = useState<"asset" | "trailer" | null>(null);
  const [optsLoading,   setOptsLoading]   = useState(true);
  const [includeTrailer, setIncludeTrailer] = useState(false);

  // ── Checklist state ───────────────────────────────────────────────
  const [items,         setItems]         = useState<Record<string, ItemState>>({});
  const [notes,         setNotes]         = useState("");
  const [submitting,    setSubmitting]    = useState(false);

  // Load asset + trailer options
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOptsLoading(true);
      try {
        const [a, t] = await Promise.all([railway.listAssets(), railway.listTrailers()]);
        if (cancelled) return;
        setAssets(a.assets as AssetOption[]);
        setTrailers(t.trailers as TrailerOption[]);
      } catch (e) {
        console.error("[InspectionForm] load options:", e);
      } finally {
        if (!cancelled) setOptsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedAsset   = useMemo(() => assets.find(a => a.id === assetId)         ?? null, [assets, assetId]);
  const selectedTrailer = useMemo(() => trailers.find(t => t.id === trailerId)     ?? null, [trailers, trailerId]);

  // Group checklist by section for the render loop
  const truckSections   = useMemo(() => groupBySection(TRUCK_CHECKLIST),   []);
  const trailerSections = useMemo(() => groupBySection(TRAILER_CHECKLIST), []);

  const setStatus = useCallback((id: string, status: ItemStatus) => {
    setItems(prev => ({ ...prev, [id]: { status, notes: prev[id]?.notes } }));
  }, []);

  const setItemNotes = useCallback((id: string, n: string) => {
    setItems(prev => ({ ...prev, [id]: { status: prev[id]?.status ?? null, notes: n } }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!assetId && !(includeTrailer && trailerId)) {
      Alert.alert("Pick equipment", "Select a truck (and optionally a trailer) to inspect.");
      return;
    }

    const buildItems = (defs: ChecklistItem[]): InspectionItemPayload[] =>
      defs
        .filter(d => items[d.id]?.status)
        .map(d => ({
          id:      d.id,
          section: d.section,
          label:   d.label,
          status:  items[d.id].status as ItemStatus,
          notes:   items[d.id].notes,
        }));

    const truckItems   = assetId ? buildItems(TRUCK_CHECKLIST)   : [];
    const trailerItems = includeTrailer && trailerId ? buildItems(TRAILER_CHECKLIST) : [];

    // Require every truck item to have a status if a truck was picked
    if (assetId && truckItems.length < TRUCK_CHECKLIST.length) {
      Alert.alert("Incomplete", "Mark every truck item Pass, Fail, or N/A before submitting.");
      return;
    }
    if (includeTrailer && trailerId && trailerItems.length < TRAILER_CHECKLIST.length) {
      Alert.alert("Incomplete", "Mark every trailer item Pass, Fail, or N/A before submitting.");
      return;
    }

    setSubmitting(true);
    try {
      await railway.submitInspection({
        assetId,
        trailerId:    includeTrailer ? trailerId : null,
        items:        truckItems,
        trailerItems: trailerItems.length > 0 ? trailerItems : undefined,
        notes:        notes.trim() || undefined,
        signedBy:     driverName,
      });
      onSubmitted();
    } catch (e) {
      console.error("[InspectionForm] submit failed:", e);
      Alert.alert("Submit failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [assetId, trailerId, includeTrailer, items, notes, driverName, onSubmitted]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: "#e5e7eb" }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <ArrowLeft size={22} color="#111827" />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 17, color: "#111827" }]}>Daily inspection</Text>
        <View style={{ flex: 1 }} />
        <Text style={[txt(500), { fontSize: 12, color: "#6b7280" }]}>{driverName}</Text>
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: "#f8f9fa" }}
        contentContainerStyle={{ padding: 14, paddingBottom: 80 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Equipment pickers */}
        <View style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <Text style={[txt(700), { fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
            Equipment
          </Text>
          <PickerRow
            icon={<Truck size={16} color="#1a73e8" />}
            label="Truck"
            value={selectedAsset ? `${selectedAsset.name}${selectedAsset.unit ? ` · #${selectedAsset.unit}` : ""}` : "Pick a truck"}
            onPress={() => setPickerOpen("asset")}
            disabled={optsLoading}
          />
          <View style={{ height: 10 }} />
          <TouchableOpacity
            onPress={() => setIncludeTrailer(t => !t)}
            style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}
          >
            <View style={{
              width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: "#1a73e8",
              alignItems: "center", justifyContent: "center",
              backgroundColor: includeTrailer ? "#1a73e8" : "white",
              marginRight: 8,
            }}>
              {includeTrailer && <Check size={12} color="white" />}
            </View>
            <Text style={[txt(500), { fontSize: 13, color: "#374151" }]}>Inspecting a trailer too</Text>
          </TouchableOpacity>
          {includeTrailer && (
            <View style={{ marginTop: 8 }}>
              <PickerRow
                icon={<Container size={16} color="#1a73e8" />}
                label="Trailer"
                value={selectedTrailer ? `${selectedTrailer.name}${selectedTrailer.trailerNumber ? ` · #${selectedTrailer.trailerNumber}` : ""}` : "Pick a trailer"}
                onPress={() => setPickerOpen("trailer")}
                disabled={optsLoading}
              />
            </View>
          )}
        </View>

        {/* Truck checklist */}
        {assetId && (
          <ChecklistBlock
            title="Truck inspection"
            sections={truckSections}
            items={items}
            setStatus={setStatus}
            setItemNotes={setItemNotes}
          />
        )}

        {/* Trailer checklist */}
        {includeTrailer && trailerId && (
          <ChecklistBlock
            title="Trailer inspection"
            sections={trailerSections}
            items={items}
            setStatus={setStatus}
            setItemNotes={setItemNotes}
          />
        )}

        {/* General notes */}
        <View style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <Text style={[txt(700), { fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }]}>
            General notes (optional)
          </Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything else worth noting…"
            placeholderTextColor="#9ca3af"
            multiline
            style={[txt(500), {
              fontSize: 14, color: "#111827", minHeight: 60,
              borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 10,
              textAlignVertical: "top",
            }]}
          />
        </View>

        {/* Signature line */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
          <Text style={[txt(500), { fontSize: 12, color: "#6b7280" }]}>Signed by </Text>
          <Text style={[txt(700), { fontSize: 13, color: "#111827" }]}>{driverName}</Text>
        </View>
      </ScrollView>

      {/* Submit button (sticky) */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: "#e5e7eb", backgroundColor: "white" }}>
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting}
          style={{
            backgroundColor: "#1a73e8", paddingVertical: 14, borderRadius: 12,
            alignItems: "center", opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting
            ? <ActivityIndicator color="white" />
            : <Text style={[txt(700), { color: "white", fontSize: 15 }]}>Submit inspection</Text>}
        </TouchableOpacity>
      </View>

      {/* Pickers — simple full-screen list overlays */}
      {pickerOpen === "asset" && (
        <PickerOverlay
          title="Pick truck"
          options={assets.map(a => ({ id: a.id, label: `${a.name}${a.unit ? ` · #${a.unit}` : ""}` }))}
          onPick={(id) => { setAssetId(id); setPickerOpen(null); }}
          onClose={() => setPickerOpen(null)}
        />
      )}
      {pickerOpen === "trailer" && (
        <PickerOverlay
          title="Pick trailer"
          options={trailers.map(t => ({ id: t.id, label: `${t.name}${t.trailerNumber ? ` · #${t.trailerNumber}` : ""}` }))}
          onPick={(id) => { setTrailerId(id); setPickerOpen(null); }}
          onClose={() => setPickerOpen(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function ChecklistBlock({
  title, sections, items, setStatus, setItemNotes,
}: {
  title: string;
  sections: { name: string; items: ChecklistItem[] }[];
  items: Record<string, ItemState>;
  setStatus: (id: string, s: ItemStatus) => void;
  setItemNotes: (id: string, n: string) => void;
}) {
  return (
    <View style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <Text style={[txt(700), { fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
        {title}
      </Text>
      {sections.map((section, sIdx) => (
        <View key={section.name} style={{ marginTop: sIdx > 0 ? 10 : 0 }}>
          <Text style={[txt(700), { fontSize: 13, color: "#111827", marginBottom: 6 }]}>{section.name}</Text>
          {section.items.map(item => {
            const state = items[item.id];
            const isFail = state?.status === "fail";
            return (
              <View key={item.id} style={{ marginBottom: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={[txt(500), { fontSize: 13, color: "#374151", flex: 1 }]}>{item.label}</Text>
                  <StatusButton label="Pass" active={state?.status === "pass"} color="#16a34a" onPress={() => setStatus(item.id, "pass")} />
                  <StatusButton label="Fail" active={state?.status === "fail"} color="#dc2626" onPress={() => setStatus(item.id, "fail")} />
                  <StatusButton label="N/A"  active={state?.status === "na"}   color="#6b7280" onPress={() => setStatus(item.id, "na")} />
                </View>
                {isFail && (
                  <TextInput
                    value={state?.notes ?? ""}
                    onChangeText={(t) => setItemNotes(item.id, t)}
                    placeholder="Describe the issue…"
                    placeholderTextColor="#9ca3af"
                    style={[txt(500), {
                      fontSize: 12, color: "#111827", marginTop: 6,
                      borderWidth: 1, borderColor: "#fecaca", backgroundColor: "#fff5f5",
                      borderRadius: 8, padding: 8,
                    }]}
                  />
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function StatusButton({ label, active, color, onPress }: { label: string; active: boolean; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6,
        backgroundColor: active ? color : "transparent",
        borderWidth: 1, borderColor: active ? color : "#e5e7eb",
      }}
    >
      <Text style={[txt(700), { fontSize: 11, color: active ? "white" : "#6b7280" }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PickerRow({ icon, label, value, onPress, disabled }: {
  icon: React.ReactNode; label: string; value: string; onPress: () => void; disabled?: boolean;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: "row", alignItems: "center", gap: 10,
        paddingVertical: 10, paddingHorizontal: 12,
        borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={[txt(500), { fontSize: 11, color: "#6b7280" }]}>{label}</Text>
        <Text style={[txt(700), { fontSize: 14, color: "#111827" }]}>{value}</Text>
      </View>
      <ChevronDown size={16} color="#9ca3af" />
    </TouchableOpacity>
  );
}

function PickerOverlay({ title, options, onPick, onClose }: {
  title: string;
  options: { id: number; label: string }[];
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  return (
    <View style={{
      position: "absolute", inset: 0, backgroundColor: "white",
    }}>
      <View style={{
        flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: "#e5e7eb", gap: 10,
      }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <X size={22} color="#111827" />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 16, color: "#111827" }]}>{title}</Text>
      </View>
      <ScrollView>
        {options.length === 0 && (
          <View style={{ padding: 24, flexDirection: "row", alignItems: "center", gap: 10, justifyContent: "center" }}>
            <AlertTriangle size={16} color="#9ca3af" />
            <Text style={[txt(500), { color: "#6b7280" }]}>No options available.</Text>
          </View>
        )}
        {options.map(opt => (
          <TouchableOpacity
            key={opt.id}
            onPress={() => onPick(opt.id)}
            style={{
              paddingHorizontal: 14, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: "#f3f4f6",
            }}
          >
            <Text style={[txt(600), { fontSize: 14, color: "#111827" }]}>{opt.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function groupBySection(items: ChecklistItem[]): { name: string; items: ChecklistItem[] }[] {
  const map = new Map<string, ChecklistItem[]>();
  for (const it of items) {
    const arr = map.get(it.section) ?? [];
    arr.push(it);
    map.set(it.section, arr);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
}
