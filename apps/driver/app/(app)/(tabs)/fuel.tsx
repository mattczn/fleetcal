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
  KeyboardAvoidingView, Platform, RefreshControl, Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Fuel, Truck, MapPin, Gauge, Check, ChevronDown, Camera, X, Receipt } from "lucide-react-native";
import * as Location from "expo-location";
import * as ImagePicker from "expo-image-picker";
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
  // Receipt photos — local URIs queued for upload on submit.
  const [receipts,       setReceipts]       = useState<Array<{ uri: string; mimeType?: string; fileName?: string }>>([]);

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
        // Race the asset list + the server's suggestion. The
        // suggestion comes from recent/upcoming dispatch events (±6h)
        // or the driver's saved preference, so 90% of the time the
        // driver opens the form and the right truck is already picked.
        const [{ assets }, suggested] = await Promise.all([
          railway.listAssets(),
          railway.suggestedAsset().catch(() => ({ assetId: null, source: null as null })),
        ]);
        if (!alive) return;
        setAssets(assets);
        if (suggested.assetId != null && assets.some(a => a.id === suggested.assetId)) {
          setAssetId(suggested.assetId);
        }
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

  // Receipt source — single entry point. Driver taps "Upload Photo",
  // sees a system alert with Camera / Library / Cancel, and the
  // appropriate picker opens. One button keeps the form clean and
  // matches the iOS pattern drivers already see in other apps.
  async function chooseReceiptSource() {
    if (receipts.length >= 4) return;
    Alert.alert(
      "Add Receipt",
      undefined,
      [
        { text: "Take Photo",          onPress: takeReceipt },
        { text: "Choose from Library", onPress: pickReceipts },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function pickReceipts() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Photos", "Enable photo access in Settings to attach receipts.");
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsMultipleSelection: true,
      quality: 0.85,
      selectionLimit: 4 - receipts.length,
    });
    if (res.canceled) return;
    setReceipts(prev => [
      ...prev,
      ...res.assets.map(a => ({
        uri: a.uri, mimeType: a.mimeType, fileName: a.fileName ?? a.uri.split("/").pop() ?? "receipt.jpg",
      })),
    ].slice(0, 4));
  }

  async function takeReceipt() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera", "Enable camera access in Settings to take receipt photos.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({ quality: 0.85 });
    if (res.canceled) return;
    const a = res.assets[0];
    if (!a) return;
    setReceipts(prev => [...prev, {
      uri: a.uri, mimeType: a.mimeType, fileName: a.fileName ?? `receipt-${Date.now()}.jpg`,
    }].slice(0, 4));
  }

  async function handleSubmit() {
    if (!canSubmit || assetId == null) return;
    setSubmitting(true);
    try {
      // Refresh GPS at submit. The driver may have moved between
      // form open and submit (opened in the cab, walked to the pump,
      // walked back). Falls back silently to mount-time coords if
      // the fresh read fails (permission revoked, indoor, etc.).
      let lat: number | undefined = gpsRef.current?.latitude;
      let lng: number | undefined = gpsRef.current?.longitude;
      try {
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        gpsRef.current = { latitude: lat, longitude: lng };
      } catch {
        // keep the mount-time values
      }

      const { fuelReport } = await railway.submitFuelReport({
        assetId,
        state,
        dieselGallons: dieselNum,
        defGallons:    defNum ?? undefined,
        odometer:      odometerNum ?? undefined,
        latitude:      lat,
        longitude:     lng,
      });

      // Upload receipts sequentially. Failures don't roll back the
      // report — driver gets a notice and can re-attach later via
      // the recent submissions list (Phase 2: edit photos on a
      // submitted report). For now the report is still useful
      // without the photo.
      const uploadFailures: string[] = [];
      for (const r of receipts) {
        try {
          const form = new FormData();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: r.uri, name: r.fileName ?? "receipt.jpg", type: r.mimeType ?? "image/jpeg" } as any);
          await railway.uploadFuelReceipt(fuelReport.id, form);
        } catch (err) {
          console.warn("[fuel] receipt upload failed:", err);
          uploadFailures.push(r.fileName ?? "receipt");
        }
      }

      // Reset the entry fields, keep the asset selection (drivers often
      // submit consecutive fills on the same truck during long days).
      setDiesel("");
      setDef("");
      setOdometer("");
      setReceipts([]);
      await refreshRecent();
      if (uploadFailures.length > 0) {
        Alert.alert("Submitted", `Report saved, but ${uploadFailures.length} receipt${uploadFailures.length === 1 ? '' : 's'} failed to upload.`);
      } else {
        Alert.alert("Submitted", "Fuel report recorded.");
      }
    } catch (err) {
      Alert.alert("Submission failed", (err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function removeReceipt(idx: number) {
    setReceipts(prev => prev.filter((_, i) => i !== idx));
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Blue top bar — matches Schedule / Loads / Profile. */}
      <View style={{ backgroundColor: "#1a73e8", paddingHorizontal: 22, paddingTop: 8, paddingBottom: 20 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <Fuel size={22} color="#fff" strokeWidth={2.4} />
          <Text style={[txt(800), { fontSize: 22, color: "#fff", letterSpacing: -0.3 }]}>
            Fuel Report
          </Text>
        </View>
      </View>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1, backgroundColor: "#f1f3f4" }}>
        <ScrollView
          contentContainerStyle={{ padding: 16, paddingBottom: 80 }}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={async () => { setRefreshing(true); await refreshRecent(); setRefreshing(false); }}
            />
          }>

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

            {/* Receipt photos */}
            <FieldLabel Icon={Receipt} label={`Receipt (${receipts.length}/4)`} />
            {/* Thumbnails row — only renders when there's at least
                one attached. Each tile gets a close-X overlay. */}
            {receipts.length > 0 && (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                {receipts.map((r, i) => (
                  <View key={`${r.uri}-${i}`} style={{ width: 72, height: 72, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
                    <Image source={{ uri: r.uri }} style={{ width: '100%', height: '100%' }} />
                    <TouchableOpacity
                      onPress={() => removeReceipt(i)}
                      style={{
                        position: 'absolute', top: 2, right: 2,
                        width: 22, height: 22, borderRadius: 11,
                        backgroundColor: 'rgba(0,0,0,0.55)',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                      <X size={12} color="#fff" strokeWidth={2.8} />
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}
            {/* Wide upload tile spans the form width. Hidden when the
                cap (4 receipts) is reached. */}
            {receipts.length < 4 && (
              <TouchableOpacity onPress={chooseReceiptSource}
                style={{
                  width: '100%',
                  paddingVertical: 18,
                  borderRadius: 10,
                  borderWidth: 1.5, borderColor: '#1a73e8', borderStyle: 'dashed',
                  alignItems: 'center', justifyContent: 'center',
                  flexDirection: 'row',
                  gap: 8,
                  backgroundColor: '#e8f0fe',
                }}>
                <Camera size={18} color="#1a73e8" strokeWidth={2.2} />
                <Text style={[txt(700), { fontSize: 14, color: '#1a73e8' }]}>
                  {receipts.length === 0 ? 'Upload Photo' : 'Add Another Photo'}
                </Text>
              </TouchableOpacity>
            )}

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
        backgroundColor: "#fff",
        borderRadius: 10,
        borderWidth: 1,
        borderColor: "#e8eaed",
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
          backgroundColor: "#fff",
          borderRadius: 10,
          borderWidth: 1,
          borderColor: "#e8eaed",
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
