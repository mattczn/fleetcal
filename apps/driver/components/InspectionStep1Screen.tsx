/**
 * InspectionStep1Screen — Step 1 of the Curzon-only Truck-History
 * inspection flow: pick the truck (+ optional trailer) and review its
 * history before starting the checklist.
 *
 *   - Truck selector defaults to railway.suggestedAsset() (the assigned
 *     truck) and is editable via a picker of railway.listAssets().
 *   - One optional trailer (from railway.listTrailers()), settable/clearable.
 *   - Equipment history for the selected truck via
 *     railway.getEquipmentHistory("asset", id) — rendered with the shared
 *     <EquipmentHistoryCards>, led by the "how it was left" cleanliness
 *     reference + known damage.
 *   - "Start Inspection" hands kind + assetId + trailerId (and the truck's
 *     open knownDamage, for Step 3) up to the coordinator.
 *
 * The two kinds (pre_trip / post_trip) run the identical screen; only the
 * header label differs. Cleanliness rules diverge later, in Step 2.
 */
import React, { useEffect, useMemo, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, ActivityIndicator, TextInput,
} from "react-native";
import { ArrowLeft, Truck, Container, ChevronDown, X, Search, AlertTriangle } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import { railway, type EquipmentHistory } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";
import EquipmentHistoryCards from "@/components/EquipmentHistoryCards";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium" :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold" :
                     "PlusJakartaSans_800ExtraBold",
});

interface AssetOption   { id: number; name: string; unit?: string; }
interface TrailerOption { id: number; name: string; trailerNumber?: string; }

interface Props {
  kind:        "pre_trip" | "post_trip";
  driverName:  string;
  onClose:     () => void;
  /** Advance to Step 2 with the chosen equipment + the truck's open work
   *  orders (threaded into Step 3 so the driver sees what's already open)
   *  + a lookup of checklist items failed in a recent inspection (so Step 2
   *  can flag them for the driver to re-check). */
  onStart:     (sel: {
    assetId: number;
    trailerId: number | null;
    knownDamage: EquipmentHistory["knownDamage"];
    recentlyFailed: Record<string, { date: string; notes?: string | null }>;
  }) => void;
}

export default function InspectionStep1Screen({ kind, driverName, onClose, onStart }: Props) {
  const { C, ACCENT } = useTheme();

  const [assets,    setAssets]    = useState<AssetOption[]>([]);
  const [trailers,  setTrailers]  = useState<TrailerOption[]>([]);
  const [assetId,   setAssetId]   = useState<number | null>(null);
  const [trailerId, setTrailerId] = useState<number | null>(null);
  const [optsLoading, setOptsLoading] = useState(true);
  const [pickerOpen,  setPickerOpen]  = useState<"asset" | "trailer" | null>(null);

  // Load assets + trailers + suggested (assigned) truck in parallel; the
  // truck selector defaults to the suggested asset but stays editable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setOptsLoading(true);
      const [a, t, suggested] = await Promise.allSettled([
        railway.listAssets(),
        railway.listTrailers(),
        railway.suggestedAsset(),
      ]);
      if (cancelled) return;
      if (a.status === "fulfilled") setAssets(a.value.assets as AssetOption[]);
      if (t.status === "fulfilled") setTrailers(t.value.trailers as TrailerOption[]);
      if (suggested.status === "fulfilled" && suggested.value.assetId != null) {
        setAssetId(prev => prev ?? suggested.value.assetId);
      }
      setOptsLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedAsset   = useMemo(() => assets.find(a => a.id === assetId) ?? null, [assets, assetId]);
  const selectedTrailer = useMemo(() => trailers.find(t => t.id === trailerId) ?? null, [trailers, trailerId]);

  // History for the currently selected truck. Re-runs when the driver
  // swaps trucks. 404 = module off (shouldn't happen here since the flow
  // is already gated, but handled defensively).
  const { data: history, isLoading: histLoading, isError, error } = useQuery({
    queryKey: ["equipment-history", "asset", assetId],
    queryFn:  () => railway.getEquipmentHistory("asset", assetId as number),
    enabled:  assetId != null,
  });
  const notAvailable = isError && /404|not found/i.test(String((error as Error)?.message ?? ""));

  // Checklist items failed in a recent inspection (last 30 days) on this
  // truck → threaded to Step 2 so each affected row shows a caution.
  // recentInspectionDefects is newest-first, so the first time we see an
  // item id wins (its most recent failing inspection).
  const recentlyFailed = useMemo(() => {
    const out: Record<string, { date: string; notes?: string | null }> = {};
    for (const insp of history?.recentInspectionDefects ?? []) {
      for (const fi of insp.failedItems) {
        if (out[fi.id]) continue;
        out[fi.id] = { date: insp.date, notes: fi.notes };
      }
    }
    return out;
  }, [history]);

  const canStart = assetId != null;

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <ArrowLeft size={22} color={C.t1} />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 17, color: C.t1, flex: 1 }]}>
          {kind === "post_trip" ? "Post-Trip Inspection" : "Pre-Trip Inspection"}
        </Text>
        <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{driverName}</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 40 }}>
        {/* Equipment selectors */}
        <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14, borderWidth: 1, borderColor: C.border }}>
          <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
            Equipment
          </Text>
          <PickerRow
            icon={<Truck size={16} color={ACCENT} />}
            label="Truck"
            value={selectedAsset ? truckLabel(selectedAsset.name, selectedAsset.unit) : (optsLoading ? "Loading…" : "Pick a truck")}
            onPress={() => setPickerOpen("asset")}
            disabled={optsLoading}
          />
          <View style={{ height: 10 }} />
          <PickerRow
            icon={<Container size={16} color={ACCENT} />}
            label="Trailer (optional)"
            value={selectedTrailer ? trailerLabel(selectedTrailer.name, selectedTrailer.trailerNumber) : "None"}
            onPress={() => setPickerOpen("trailer")}
            disabled={optsLoading}
            onClear={selectedTrailer ? () => setTrailerId(null) : undefined}
          />
        </View>

        {/* Equipment history — reference before starting the checklist.
            Led by the "how it was left" cleanliness photo + known damage. */}
        {assetId == null ? (
          <CenteredNote title="Pick a truck" subtitle="Select a truck above to review its history." />
        ) : histLoading ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : notAvailable ? (
          <CenteredNote title="Not available" subtitle="Truck history isn't enabled for this fleet." />
        ) : isError ? (
          <CenteredNote title="Couldn't load history" subtitle="Pull back and try again." />
        ) : history ? (
          <EquipmentHistoryCards data={history} order={["cleanliness", "damage", "defects", "drivers"]} />
        ) : null}
      </ScrollView>

      {/* Start Inspection (sticky) */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.surface }}>
        <TouchableOpacity
          onPress={() => {
            if (assetId == null) return;
            onStart({ assetId, trailerId, knownDamage: history?.knownDamage ?? [], recentlyFailed });
          }}
          disabled={!canStart}
          style={{
            backgroundColor: ACCENT, paddingVertical: 16, borderRadius: 12,
            alignItems: "center", opacity: canStart ? 1 : 0.5,
          }}
        >
          <Text style={[txt(700), { color: "white", fontSize: 16 }]}>Start Inspection</Text>
        </TouchableOpacity>
      </View>

      {/* Pickers — full-screen list overlays */}
      {pickerOpen === "asset" && (
        <PickerOverlay
          title="Pick truck"
          options={assets.map(a => ({ id: a.id, label: truckLabel(a.name, a.unit) }))}
          onPick={(id) => { setAssetId(id); setPickerOpen(null); }}
          onClose={() => setPickerOpen(null)}
        />
      )}
      {pickerOpen === "trailer" && (
        <PickerOverlay
          title="Pick trailer"
          options={trailers.map(t => ({ id: t.id, label: trailerLabel(t.name, t.trailerNumber) }))}
          onPick={(id) => { setTrailerId(id); setPickerOpen(null); }}
          onClose={() => setPickerOpen(null)}
          allowNone={() => { setTrailerId(null); setPickerOpen(null); }}
        />
      )}
    </View>
  );
}

// ─── Building blocks ──────────────────────────────────────────────────

function PickerRow({ icon, label, value, onPress, disabled, onClear }: {
  icon: React.ReactNode; label: string; value: string; onPress: () => void; disabled?: boolean; onClear?: () => void;
}) {
  const { C } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: "row", alignItems: "center", gap: 10,
        paddingVertical: 12, paddingHorizontal: 12,
        borderWidth: 1, borderColor: C.border, borderRadius: 10,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{label}</Text>
        <Text style={[txt(700), { fontSize: 16, color: C.t1 }]}>{value}</Text>
      </View>
      {onClear ? (
        <TouchableOpacity onPress={onClear} hitSlop={10} style={{ padding: 4 }}>
          <X size={16} color={C.t4} />
        </TouchableOpacity>
      ) : (
        <ChevronDown size={16} color={C.t4} />
      )}
    </TouchableOpacity>
  );
}

function PickerOverlay({ title, options, onPick, onClose, allowNone }: {
  title: string;
  options: { id: number; label: string }[];
  onPick: (id: number) => void;
  onClose: () => void;
  /** When set, shows a "None" row at the top that clears the selection. */
  allowNone?: () => void;
}) {
  const { C } = useTheme();
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    const tokens = q.split(/\s+/);
    return options.filter(opt => {
      const hay = opt.label.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }, [query, options]);

  return (
    <View style={{ position: "absolute", inset: 0, backgroundColor: C.surface }}>
      <View style={{
        flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12,
        borderBottomWidth: 1, borderBottomColor: C.border, gap: 10,
      }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <X size={22} color={C.t1} />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 16, color: C.t1, flex: 1 }]}>{title}</Text>
        <Text style={[txt(500), { fontSize: 12, color: C.t4 }]}>
          {filtered.length}{query ? ` / ${options.length}` : ""}
        </Text>
      </View>

      {options.length >= 6 && (
        <View style={{
          flexDirection: "row", alignItems: "center", gap: 8,
          paddingHorizontal: 14, paddingVertical: 10,
          borderBottomWidth: 1, borderBottomColor: C.borderSoft,
        }}>
          <View style={{
            flex: 1, flexDirection: "row", alignItems: "center", gap: 8,
            paddingHorizontal: 12, paddingVertical: 10,
            borderWidth: 1, borderColor: C.border, borderRadius: 10,
            backgroundColor: C.surface2,
          }}>
            <Search size={16} color={C.t4} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search by name or number…"
              placeholderTextColor={C.t4}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={[txt(500), { flex: 1, fontSize: 15, color: C.t1, padding: 0 }]}
            />
            {query.length > 0 && (
              <TouchableOpacity onPress={() => setQuery("")} hitSlop={10}>
                <X size={16} color={C.t4} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <ScrollView keyboardShouldPersistTaps="handled">
        {allowNone && (
          <TouchableOpacity
            onPress={allowNone}
            style={{ paddingHorizontal: 14, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}
          >
            <Text style={[txt(600), { fontSize: 16, color: C.t3 }]}>None</Text>
          </TouchableOpacity>
        )}
        {options.length === 0 ? (
          <View style={{ padding: 24, flexDirection: "row", alignItems: "center", gap: 10, justifyContent: "center" }}>
            <AlertTriangle size={16} color={C.t4} />
            <Text style={[txt(500), { color: C.t3 }]}>No options available.</Text>
          </View>
        ) : filtered.length === 0 ? (
          <View style={{ padding: 32, alignItems: "center", gap: 6 }}>
            <Text style={[txt(700), { color: C.t2, fontSize: 15 }]}>No matches</Text>
            <Text style={[txt(500), { color: C.t4, fontSize: 13, textAlign: "center" }]}>
              Nothing matched “{query.trim()}”. Try a different name or number.
            </Text>
          </View>
        ) : (
          filtered.map(opt => (
            <TouchableOpacity
              key={opt.id}
              onPress={() => onPick(opt.id)}
              style={{ paddingHorizontal: 14, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}
            >
              <Text style={[txt(600), { fontSize: 16, color: C.t1 }]}>{opt.label}</Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

function CenteredNote({ title, subtitle }: { title: string; subtitle: string }) {
  const { C } = useTheme();
  return (
    <View style={{ alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }}>
      <AlertTriangle size={26} color={C.t4} />
      <Text style={[txt(700), { fontSize: 15, color: C.t2 }]}>{title}</Text>
      <Text style={[txt(500), { fontSize: 13, color: C.t4, textAlign: "center" }]}>{subtitle}</Text>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function truckLabel(name: string, unit: string | null | undefined): string {
  return `Truck ${name}${unit ? ` #${unit}` : ""}`;
}

function trailerLabel(name: string, trailerNumber: string | null | undefined): string {
  if (trailerNumber) return `Trailer #${trailerNumber}`;
  return `Trailer ${name}`;
}
