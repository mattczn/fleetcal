/**
 * Driver fuel-report form.
 *
 * The driver is already authenticated (Supabase JWT via driverAuth on
 * the API), so we only need three pieces of input that the app can't
 * derive on its own:
 *   1. Which asset they're fueling   — pickable from the org's asset list
 *   2. Diesel gallons + optional DEF + optional odometer
 *
 * Driver, state, GPS, and timestamp are all auto-captured.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, RefreshControl,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Fuel, Truck, MapPin, Hash, Gauge, Check, ChevronDown } from "lucide-react-native";
import * as Location from "expo-location";
import { railway } from "@/lib/railway";
import type { FuelReport } from "@fleetcal/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];

interface AssetOption {
  id: number;
  name: string;
  unit?: string;
  truck?: string;
}

// ── GPS → state helpers ────────────────────────────────────────────────

/** expo-location's `reverseGeocodeAsync` returns the state as either an
 *  ISO code ("UT"), a full name ("Utah"), or undefined depending on
 *  platform. Normalize to the 2-letter abbreviation we store. */
const STATE_NAME_TO_ABBR: Record<string, string> = (() => {
  const pairs: [string, string][] = [
    ["Alabama","AL"],["Alaska","AK"],["Arizona","AZ"],["Arkansas","AR"],
    ["California","CA"],["Colorado","CO"],["Connecticut","CT"],["Delaware","DE"],
    ["Florida","FL"],["Georgia","GA"],["Hawaii","HI"],["Idaho","ID"],
    ["Illinois","IL"],["Indiana","IN"],["Iowa","IA"],["Kansas","KS"],
    ["Kentucky","KY"],["Louisiana","LA"],["Maine","ME"],["Maryland","MD"],
    ["Massachusetts","MA"],["Michigan","MI"],["Minnesota","MN"],["Mississippi","MS"],
    ["Missouri","MO"],["Montana","MT"],["Nebraska","NE"],["Nevada","NV"],
    ["New Hampshire","NH"],["New Jersey","NJ"],["New Mexico","NM"],["New York","NY"],
    ["North Carolina","NC"],["North Dakota","ND"],["Ohio","OH"],["Oklahoma","OK"],
    ["Oregon","OR"],["Pennsylvania","PA"],["Rhode Island","RI"],["South Carolina","SC"],
    ["South Dakota","SD"],["Tennessee","TN"],["Texas","TX"],["Utah","UT"],
    ["Vermont","VT"],["Virginia","VA"],["Washington","WA"],["West Virginia","WV"],
    ["Wisconsin","WI"],["Wyoming","WY"],
  ];
  return Object.fromEntries(pairs);
})();

function normalizeStateValue(raw?: string | null): string | null {
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (US_STATES.includes(upper)) return upper;
  const byName = STATE_NAME_TO_ABBR[raw.replace(/\s+/g, " ").trim()];
  return byName ?? null;
}

// ── Screen ──────────────────────────────────────────────────────────────

export default function FuelScreen() {
  const [assets,         setAssets]         = useState<AssetOption[]>([]);
  const [assetsLoading,  setAssetsLoading]  = useState(true);
  const [assetId,        setAssetId]        = useState<number | null>(null);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);

  const [state,          setState]          = useState<string>("");
  const [stateSource,    setStateSource]    = useState<"gps" | "manual" | null>(null);
  const [statePickerOpen, setStatePickerOpen] = useState(false);

  const [diesel,         setDiesel]         = useState("");
  const [def,            setDef]            = useState("");
  const [odometer,       setOdometer]       = useState("");
  const [notes,          setNotes]          = useState("");

  const [submitting,     setSubmitting]     = useState(false);
  const [recent,         setRecent]         = useState<FuelReport[]>([]);
  const [refreshing,     setRefreshing]     = useState(false);

  // Track GPS coords so they're attached to the submission for later
  // verification (e.g. dispute resolution if the state looks wrong).
  const gpsRef = useRef<{ latitude: number; longitude: number } | null>(null);

  const refreshRecent = useCallback(async () => {
    try {
      const { fuelReports } = await railway.listFuelReports(20);
      setRecent(fuelReports);
    } catch (err) {
      console.warn("[fuel] list recent failed:", err);
    }
  }, []);

  // Initial load: assets + recent submissions + GPS-state detection.
  useEffect(() => {
    let alive = true;

    void (async () => {
      try {
        const { assets } = await railway.listAssets();
        if (!alive) return;
        setAssets(assets);
      } catch (err) {
        console.warn("[fuel] list assets failed:", err);
      } finally {
        if (alive) setAssetsLoading(false);
      }
    })();

    void refreshRecent();

    void (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (!alive) return;
        gpsRef.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };

        const results = await Location.reverseGeocodeAsync({
          latitude:  pos.coords.latitude,
          longitude: pos.coords.longitude,
        });
        if (!alive) return;
        const first = results[0];
        const abbr  = normalizeStateValue(first?.isoCountryCode === "US"
          ? (first?.region ?? first?.subregion ?? null)
          : null);
        if (abbr) {
          setState(abbr);
          setStateSource("gps");
        }
      } catch (err) {
        console.warn("[fuel] GPS detect failed:", err);
      }
    })();

    return () => { alive = false; };
  }, [refreshRecent]);

  const selectedAsset = useMemo(
    () => assets.find(a => a.id === assetId) ?? null,
    [assets, assetId],
  );

  const dieselNum   = parseFloat(diesel);
  const defNum      = def.trim() ? parseFloat(def) : null;
  const odometerNum = odometer.trim() ? parseInt(odometer, 10) : null;

  const canSubmit =
    assetId != null &&
    state.length === 2 &&
    Number.isFinite(dieselNum) && dieselNum > 0 &&
    (defNum === null || (Number.isFinite(defNum) && defNum >= 0)) &&
    (odometerNum === null || (Number.isInteger(odometerNum) && odometerNum >= 0)) &&
    !submitting;

  async function handleSubmit() {
    if (!canSubmit || assetId == null) return;
    setSubmitting(true);
    try {
      await railway.submitFuelReport({
        assetId,
        state,
        dieselGallons: dieselNum,
        defGallons:    defNum ?? undefined,
        odometer:      odometerNum ?? undefined,
        notes:         notes.trim() || undefined,
        latitude:      gpsRef.current?.latitude,
        longitude:     gpsRef.current?.longitude,
      });
      // Reset the entry fields, keep the asset selection (drivers often
      // submit consecutive fills on the same truck during long days).
      setDiesel("");
      setDef("");
      setOdometer("");
      setNotes("");
      await refreshRecent();
      Alert.alert("Submitted", "Fuel report recorded.");
    } catch (err) {
      Alert.alert("Submission failed", (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f1f3f4" }} edges={["top"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await refreshRecent(); setRefreshing(false); }}
            />
          }>
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 18 }}>
            <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: "#e8f0fe", alignItems: "center", justifyContent: "center", marginRight: 10 }}>
              <Fuel size={18} color="#1a73e8" strokeWidth={2.4} />
            </View>
            <Text style={[txt(800), { fontSize: 22, color: "#202124" }]}>Fuel Report</Text>
          </View>

          {/* Form card */}
          <View style={{ backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
            {/* Asset */}
            <FieldLabel Icon={Truck} label="Asset" required />
            <PickerRow
              placeholder={assetsLoading ? "Loading…" : "Select asset"}
              value={selectedAsset
                ? formatAssetLabel(selectedAsset)
                : null}
              onPress={() => { if (!assetsLoading) setAssetPickerOpen(o => !o); }}
            />
            {assetPickerOpen && (
              <PickerList
                items={assets.map(a => ({ key: String(a.id), label: formatAssetLabel(a), value: a.id }))}
                onSelect={(value) => { setAssetId(value as number); setAssetPickerOpen(false); }}
              />
            )}

            {/* State */}
            <FieldLabel Icon={MapPin} label="State" required hint={stateSource === "gps" ? "auto from GPS" : undefined} />
            <PickerRow
              placeholder="Select state"
              value={state || null}
              onPress={() => setStatePickerOpen(o => !o)}
            />
            {statePickerOpen && (
              <PickerList
                items={US_STATES.map(s => ({ key: s, label: s, value: s }))}
                onSelect={(value) => { setState(value as string); setStateSource("manual"); setStatePickerOpen(false); }}
              />
            )}

            {/* Diesel + DEF */}
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <FieldLabel Icon={Fuel} label="Diesel (gal)" required />
                <NumberInput value={diesel} onChangeText={setDiesel} placeholder="0.00" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel Icon={Fuel} label="DEF (gal)" />
                <NumberInput value={def} onChangeText={setDef} placeholder="0.00" />
              </View>
            </View>

            {/* Odometer */}
            <FieldLabel Icon={Gauge} label="Odometer" />
            <NumberInput value={odometer} onChangeText={setOdometer} placeholder="Miles" integer />

            {/* Notes */}
            <FieldLabel Icon={Hash} label="Notes" />
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Optional"
              placeholderTextColor="#9aa0a6"
              multiline
              style={[
                txt(600),
                {
                  backgroundColor: "#f8f9fa",
                  borderRadius: 10,
                  paddingHorizontal: 12,
                  paddingVertical:   10,
                  fontSize: 15,
                  color: "#202124",
                  marginBottom: 6,
                  minHeight: 56,
                  textAlignVertical: "top",
                },
              ]}
            />

            {/* Submit */}
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!canSubmit}
              activeOpacity={0.85}
              style={{
                marginTop: 16,
                backgroundColor: canSubmit ? "#1a73e8" : "#c5cae9",
                borderRadius: 12,
                paddingVertical: 14,
                alignItems: "center",
                flexDirection: "row",
                justifyContent: "center",
                gap: 8,
              }}>
              {submitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Check size={18} color="#fff" strokeWidth={2.6} />
              )}
              <Text style={[txt(800), { fontSize: 15, color: "#fff", letterSpacing: 0.3 }]}>
                {submitting ? "Submitting…" : "Submit Report"}
              </Text>
            </TouchableOpacity>
          </View>

          {/* Recent submissions */}
          <View style={{ marginTop: 24 }}>
            <Text style={[txt(800), { fontSize: 11, color: "#5f6368", letterSpacing: 1.1, marginBottom: 8 }]}>
              YOUR RECENT REPORTS
            </Text>
            {recent.length === 0 ? (
              <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", padding: 12 }]}>
                No submissions yet.
              </Text>
            ) : (
              recent.map(r => <RecentRow key={r.id} report={r} assets={assets} />)
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// ── Subcomponents ───────────────────────────────────────────────────────

function formatAssetLabel(a: AssetOption): string {
  if (a.unit) return `#${a.unit}${a.name ? ` · ${a.name}` : ""}`;
  return a.name;
}

function FieldLabel({
  Icon, label, required, hint,
}: {
  Icon: typeof Truck; label: string; required?: boolean; hint?: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 6, gap: 6 }}>
      <Icon size={12} color="#5f6368" strokeWidth={2.2} />
      <Text style={[txt(700), { fontSize: 11, color: "#5f6368", letterSpacing: 0.5, textTransform: "uppercase" }]}>
        {label}
      </Text>
      {required && <Text style={[txt(700), { fontSize: 11, color: "#c62828" }]}>*</Text>}
      {hint && (
        <Text style={[txt(500), { fontSize: 10, color: "#9aa0a6", letterSpacing: 0.2 }]}>
          — {hint}
        </Text>
      )}
    </View>
  );
}

function PickerRow({
  placeholder, value, onPress,
}: {
  placeholder: string; value: string | null; onPress: () => void;
}) {
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        backgroundColor: "#f8f9fa",
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 12,
      }}>
      <Text style={[txt(value ? 700 : 500), { fontSize: 15, color: value ? "#202124" : "#9aa0a6" }]}>
        {value ?? placeholder}
      </Text>
      <ChevronDown size={16} color="#5f6368" />
    </TouchableOpacity>
  );
}

function PickerList<T>({
  items, onSelect,
}: {
  items: { key: string; label: string; value: T }[];
  onSelect: (value: T) => void;
}) {
  return (
    <View
      style={{
        marginTop: 6,
        backgroundColor: "#fff",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#e8eaed",
        maxHeight: 260,
        overflow: "hidden",
      }}>
      <ScrollView nestedScrollEnabled>
        {items.map(it => (
          <TouchableOpacity
            key={it.key}
            onPress={() => onSelect(it.value)}
            activeOpacity={0.6}
            style={{ paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
            <Text style={[txt(600), { fontSize: 14, color: "#202124" }]}>{it.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

function NumberInput({
  value, onChangeText, placeholder, integer,
}: {
  value: string; onChangeText: (v: string) => void; placeholder?: string; integer?: boolean;
}) {
  return (
    <TextInput
      value={value}
      onChangeText={(v) => {
        // Strip non-numeric. Allow one decimal point unless `integer`.
        if (integer) onChangeText(v.replace(/[^0-9]/g, ""));
        else         onChangeText(v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1"));
      }}
      keyboardType="decimal-pad"
      placeholder={placeholder}
      placeholderTextColor="#9aa0a6"
      style={[
        txt(700),
        {
          backgroundColor: "#f8f9fa",
          borderRadius: 10,
          paddingHorizontal: 12,
          paddingVertical: 12,
          fontSize: 16,
          color: "#202124",
          marginBottom: 4,
        },
      ]}
    />
  );
}

function RecentRow({
  report, assets,
}: {
  report: FuelReport; assets: AssetOption[];
}) {
  const asset = assets.find(a => a.id === report.assetId);
  const date  = new Date(report.reportedAt);
  const dateLabel = `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  }`;
  return (
    <View
      style={{
        backgroundColor: "#fff",
        borderRadius: 10,
        padding: 12,
        marginBottom: 8,
        flexDirection: "row",
        alignItems: "center",
      }}>
      <View style={{ flex: 1 }}>
        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]}>
          {asset ? formatAssetLabel(asset) : `Asset #${report.assetId}`} · {report.state}
        </Text>
        <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
          {dateLabel}
          {report.odometer != null ? ` · ${report.odometer.toLocaleString()} mi` : ""}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={[txt(800), { fontSize: 14, color: "#1a73e8" }]}>
          {Number(report.dieselGallons).toFixed(1)} gal
        </Text>
        {report.defGallons != null && report.defGallons > 0 && (
          <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6" }]}>
            DEF {Number(report.defGallons).toFixed(1)}
          </Text>
        )}
      </View>
    </View>
  );
}
