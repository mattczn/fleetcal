/**
 * InspectionFormScreen — the daily DVIR (Driver Vehicle Inspection
 * Report) form. Drivers tap "Complete today's inspection" on the
 * Active loads tab, this screen mounts, they pick truck (+ optional
 * trailer), review the 59-item Motive-style checklist (every item
 * defaults to PASS), tap Fail on anything broken and snap a photo,
 * sign + submit.
 *
 * Compliance signals we capture beyond the checklist:
 *   - duration_seconds — from form open to submit. A 4-second submit on
 *     a 59-item list is a tell that the driver rubber-stamped, and
 *     dispatch can sort by it.
 *   - location_lat / location_lon — GPS at submit. Proves the driver
 *     was with the truck.
 *   - per-item photos on Fail — the actual evidence dispatch needs to
 *     act on the defect.
 *
 * Drivers can submit more than once a day (used when they swap
 * equipment mid-day). The active-tab card surfaces the count and lists
 * each entry.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, TextInput, Alert, ActivityIndicator,
  KeyboardAvoidingView, Platform, Image,
} from "react-native";
import {
  Truck, Container, ChevronDown, Check, X, ArrowLeft, AlertTriangle,
  Camera, Plus, Trash2,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
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
// 24 items, not 59. Motive's full catalog is built for every commercial
// vehicle class (school buses, paratransit, etc.) — most rows don't
// apply to a Class 8 dry-van OTR fleet, and drivers who pencil-whip 59
// items every morning learn to pencil-whip everything.
//
// The list below is designed around three principles:
//
//   1. ALL §396.11 post-trip & §392.7 pre-trip required items are
//      present — this is non-negotiable DOT compliance:
//        service brakes, parking brake, steering, lights, tires, horn,
//        wipers, mirrors, coupling devices, wheels & rims, emergency
//        equipment. Cutting any of these breaks compliance.
//
//   2. High-yield walkaround items that catch real failures: air
//      system (leak-down test), suspension, engine fluids/leaks,
//      exhaust, frame, windshield, dashboard sweep, seatbelt.
//
//   3. Drop anything that is (a) only on Motive's list because it
//      covers bus fleets (Stop Arm, Wheelchair Lift, AV Battery,
//      Service/Emergency Door, First Aid Kit — not federally required
//      for general trucking), (b) redundant (Muffler + Tail Pipe →
//      Exhaust; Headlights + Tail Lights + Directional + Reflectors
//      collapsed; Power Steering + Front Axle → Steering / Suspension),
//      or (c) self-evident from just driving (Clutch, Starter,
//      Battery, Switches).

interface ChecklistItem { id: string; section: string; label: string; }

const TRUCK_CHECKLIST: ChecklistItem[] = [
  // Brakes & air — §396.11 required: service brakes, parking brake
  { id: "service_brakes",   section: "Brakes & air",          label: "Service Brakes" },
  { id: "parking_brakes",   section: "Brakes & air",          label: "Parking Brake" },
  { id: "air_system",       section: "Brakes & air",          label: "Air System (lines, compressor, leaks)" },
  { id: "brake_accessories",section: "Brakes & air",          label: "Brake Accessories (slack adjusters, drums, hoses)" },

  // Engine bay — high-yield, catches the failures that strand a truck
  { id: "engine",           section: "Engine",                label: "Engine (oil, coolant, leaks)" },
  { id: "fluid_levels",     section: "Engine",                label: "Fluid Levels (washer, power steering, DEF)" },
  { id: "belts_hoses",      section: "Engine",                label: "Belts & Hoses" },
  { id: "exhaust",          section: "Engine",                label: "Exhaust System" },

  // Steering, drivetrain, suspension — §396.11 required: steering
  { id: "steering",         section: "Steering & drivetrain", label: "Steering (free play, linkage)" },
  { id: "transmission",     section: "Steering & drivetrain", label: "Transmission / Drive Line" },
  { id: "suspension",       section: "Steering & drivetrain", label: "Suspension (springs, airbags, shocks)" },
  { id: "frame_assembly",   section: "Steering & drivetrain", label: "Frame & Mounts" },

  // Tires & wheels — §396.11 required: tires, wheels & rims
  { id: "tires",            section: "Tires & wheels",        label: "Tires (tread, pressure, damage)" },
  { id: "wheels_rims",      section: "Tires & wheels",        label: "Wheels & Rims (lug nuts, hub seals)" },

  // Lights & reflectors — §396.11 required: lighting devices & reflectors
  { id: "lights_all",       section: "Lights",                label: "Headlights / Tail / Brake / Turn Signals" },
  { id: "reflectors",       section: "Lights",                label: "Reflectors & Marker Lights" },

  // Cab & visibility — §396.11 required: horn, wipers, mirrors
  { id: "windshield_wipers",section: "Cab & visibility",      label: "Windshield / Wipers / Washers" },
  { id: "mirrors",          section: "Cab & visibility",      label: "Mirrors" },
  { id: "horn",             section: "Cab & visibility",      label: "Horn" },

  // Dashboard & driver area
  { id: "gauges",           section: "Driver area",           label: "Gauges & Warning Lights" },
  { id: "driver_seat_belt", section: "Driver area",           label: "Driver's Seat & Seatbelt" },

  // Coupling — §396.11 required: coupling devices
  { id: "coupling_devices", section: "Coupling",              label: "Coupling / Fifth Wheel / Kingpin" },

  // Safety equipment — §396.11 required: emergency equipment
  { id: "emergency_equip",  section: "Safety equipment",      label: "Emergency Equipment (fire extinguisher, triangles, fuses)" },

  // Catch-all so a driver can flag anything the list missed
  { id: "other",            section: "Other",                 label: "Other" },
];

// Trailer-side: 11 items focused on what's actually trailer-specific.
// Cut everything that's covered by the truck list when both are
// inspected (the air-system & brakes show up under the truck because
// the leak-down test exercises the trailer connections too).
const TRAILER_CHECKLIST: ChecklistItem[] = [
  { id: "tr_coupling",      section: "Coupling",              label: "Kingpin / Fifth Wheel Engagement" },
  { id: "tr_air_electrical",section: "Coupling",              label: "Air & Electrical Lines (glad hands, 7-pin)" },
  { id: "tr_landing_gear",  section: "Coupling",              label: "Landing Gear" },
  { id: "tr_brakes",        section: "Trailer brakes",        label: "Service Brakes & Connections" },
  { id: "tr_tires",         section: "Trailer tires",         label: "Tires" },
  { id: "tr_wheels",        section: "Trailer tires",         label: "Wheels & Rims" },
  { id: "tr_lights",        section: "Trailer lights",        label: "Tail / Brake / Turn / Marker Lights" },
  { id: "tr_reflectors",    section: "Trailer lights",        label: "Reflectors & Conspicuity Tape" },
  { id: "tr_suspension",    section: "Trailer body",          label: "Suspension & Frame" },
  { id: "tr_body",          section: "Trailer body",          label: "Body / Doors / Floor" },
  { id: "tr_other",         section: "Other",                 label: "Other" },
];

type ItemStatus = "pass" | "fail" | "na";
interface ItemState { status: ItemStatus; notes?: string }

/** Default-everything-to-pass map. Built once per checklist so the
 *  initial render of 59 items doesn't need 59 effects to populate. */
function defaultsFor(list: ChecklistItem[]): Record<string, ItemState> {
  const out: Record<string, ItemState> = {};
  for (const it of list) out[it.id] = { status: "pass" };
  return out;
}

interface PendingPhoto {
  /** Stable client id so React can key the thumbnail before upload. */
  key:      string;
  uri:      string;
  fileName: string;
  mimeType: string;
  /** Checklist item this photo is attached to. null = general photo. */
  itemId:   string | null;
}

interface Props {
  /** Initial asset to select. Defaults to the driver's currently
   *  assigned truck if known; null triggers a server lookup via
   *  /v1/driver/suggested-asset. */
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

  // ── Checklist state — every item defaults to PASS so the driver
  //    only has to touch the ones that actually have a problem.
  const [items, setItems] = useState<Record<string, ItemState>>(() => ({
    ...defaultsFor(TRUCK_CHECKLIST),
    ...defaultsFor(TRAILER_CHECKLIST),
  }));
  const [notes,       setNotes]       = useState("");
  const [photos,      setPhotos]      = useState<PendingPhoto[]>([]);
  const [submitting,  setSubmitting]  = useState(false);
  const [photoTarget, setPhotoTarget] = useState<string | null>(null); // itemId being photographed (UI hint)

  // ── Compliance signals — captured at mount, sent at submit.
  // openedAtRef is a ref (not state) so re-renders don't reset the
  // start time. gpsRef caches the mount-time read; we re-fetch at
  // submit so we get the most accurate coords for the actual signing
  // location.
  const openedAtRef = useRef<number>(Date.now());
  const gpsRef      = useRef<{ latitude: number; longitude: number } | null>(null);

  // Load asset + trailer options + suggested asset in parallel.
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
      // Only auto-fill if the caller didn't already pin an asset.
      // Suggested-asset lookup: active event > stored preference.
      if (assetId == null && suggested.status === "fulfilled" && suggested.value.assetId != null) {
        setAssetId(suggested.value.assetId);
      }
      setOptsLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request location once at mount. Permission denial isn't fatal —
  // we'll just submit without coords. Don't block the form on it.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (perm.status !== "granted") return;
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!alive) return;
        gpsRef.current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      } catch {
        // ignore — we'll try once more at submit
      }
    })();
    return () => { alive = false; };
  }, []);

  const selectedAsset   = useMemo(() => assets.find(a => a.id === assetId)         ?? null, [assets, assetId]);
  const selectedTrailer = useMemo(() => trailers.find(t => t.id === trailerId)     ?? null, [trailers, trailerId]);

  const truckSections   = useMemo(() => groupBySection(TRUCK_CHECKLIST),   []);
  const trailerSections = useMemo(() => groupBySection(TRAILER_CHECKLIST), []);

  const setStatus = useCallback((id: string, status: ItemStatus) => {
    setItems(prev => ({ ...prev, [id]: { status, notes: prev[id]?.notes } }));
  }, []);

  const setItemNotes = useCallback((id: string, n: string) => {
    setItems(prev => ({ ...prev, [id]: { status: prev[id]?.status ?? "pass", notes: n } }));
  }, []);

  // ── Photos ────────────────────────────────────────────────────────
  // Per-item photo flow: tapping the camera on a Fail row pops the
  // standard Take-Photo / Choose-from-Library sheet. Photos are queued
  // locally (PendingPhoto) and uploaded sequentially after the report
  // row is created, so each upload knows the inspection id.
  const addPhotoFor = useCallback(async (itemId: string | null) => {
    if (photos.length >= 12) {
      Alert.alert("Limit reached", "Up to 12 photos per inspection.");
      return;
    }
    setPhotoTarget(itemId);
    Alert.alert(
      itemId ? "Add photo for this item" : "Add general photo",
      undefined,
      [
        {
          text: "Take Photo",
          onPress: async () => {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) {
              Alert.alert("Camera", "Enable camera access in Settings.");
              return;
            }
            const res = await ImagePicker.launchCameraAsync({ quality: 0.8 });
            if (res.canceled) return;
            const a = res.assets[0];
            if (!a) return;
            setPhotos(p => [...p, {
              key:      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              uri:      a.uri,
              fileName: a.fileName ?? `inspection-${Date.now()}.jpg`,
              mimeType: a.mimeType ?? "image/jpeg",
              itemId,
            }]);
          },
        },
        {
          text: "Choose from Library",
          onPress: async () => {
            const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
            if (!perm.granted) {
              Alert.alert("Photos", "Enable photo access in Settings.");
              return;
            }
            const res = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ImagePicker.MediaTypeOptions.Images,
              quality: 0.8,
              allowsMultipleSelection: true,
              selectionLimit: Math.max(1, 12 - photos.length),
            });
            if (res.canceled) return;
            setPhotos(p => [
              ...p,
              ...res.assets.map(a => ({
                key:      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                uri:      a.uri,
                fileName: a.fileName ?? `inspection-${Date.now()}.jpg`,
                mimeType: a.mimeType ?? "image/jpeg",
                itemId,
              })),
            ]);
          },
        },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }, [photos.length]);

  const removePhoto = useCallback((key: string) => {
    setPhotos(p => p.filter(x => x.key !== key));
  }, []);

  // ── Submit ────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!assetId && !(includeTrailer && trailerId)) {
      Alert.alert("Pick equipment", "Select a truck (and optionally a trailer) to inspect.");
      return;
    }

    const buildItems = (defs: ChecklistItem[]): InspectionItemPayload[] =>
      defs.map(d => ({
        id:      d.id,
        section: d.section,
        label:   d.label,
        status:  items[d.id]?.status ?? "pass",
        notes:   items[d.id]?.notes,
      }));

    const truckItems   = assetId ? buildItems(TRUCK_CHECKLIST)   : [];
    const trailerItems = includeTrailer && trailerId ? buildItems(TRAILER_CHECKLIST) : [];

    // Wall-clock duration from form open to submit. Server clamps to
    // [0, 24h] in case of weird system clocks.
    const durationSeconds = Math.max(0, Math.round((Date.now() - openedAtRef.current) / 1000));

    // One more GPS read for the most accurate signing location — falls
    // back silently to the mount-time read if denied / unavailable.
    let lat: number | null = gpsRef.current?.latitude  ?? null;
    let lon: number | null = gpsRef.current?.longitude ?? null;
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      lat = pos.coords.latitude;
      lon = pos.coords.longitude;
    } catch { /* keep mount-time values */ }

    setSubmitting(true);
    try {
      const { inspection } = await railway.submitInspection({
        assetId,
        trailerId:       includeTrailer ? trailerId : null,
        items:           truckItems,
        trailerItems:    trailerItems.length > 0 ? trailerItems : undefined,
        notes:           notes.trim() || undefined,
        signedBy:        driverName,
        durationSeconds,
        locationLat:     lat,
        locationLon:     lon,
      });

      // Upload photos sequentially against the new inspection. A
      // failure surfaces a notice but doesn't roll back the report —
      // the inspection itself is still valid, the driver just lost
      // some attachments.
      const photoFailures: string[] = [];
      for (const ph of photos) {
        try {
          const form = new FormData();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: ph.uri, name: ph.fileName, type: ph.mimeType } as any);
          if (ph.itemId) form.append("itemId", ph.itemId);
          await railway.uploadInspectionPhoto(inspection.id, form);
        } catch (err) {
          console.warn("[inspection] photo upload failed:", err);
          photoFailures.push(ph.fileName);
        }
      }

      if (photoFailures.length > 0) {
        Alert.alert("Submitted",
          `Inspection saved, but ${photoFailures.length} photo${photoFailures.length === 1 ? "" : "s"} failed to upload.`);
      }

      onSubmitted();
    } catch (e) {
      console.error("[InspectionForm] submit failed:", e);
      Alert.alert("Submit failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [assetId, trailerId, includeTrailer, items, notes, driverName, photos, onSubmitted]);

  const failCount = useMemo(
    () => Object.values(items).filter(s => s.status === "fail").length,
    [items],
  );

  // Photos that aren't pinned to a specific item — surfaced in a
  // dedicated "General photos" block so the driver can also add
  // odometer / nameplate / etc. shots.
  const generalPhotos = photos.filter(p => p.itemId == null);

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
        contentContainerStyle={{ padding: 14, paddingBottom: 100 }}
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
            <Text style={[txt(500), { fontSize: 14, color: "#374151" }]}>Inspecting a trailer too</Text>
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

        {/* Helper banner — "default is pass, only mark failures" */}
        <View style={{
          flexDirection: "row", alignItems: "flex-start", gap: 10,
          backgroundColor: "#eff6ff", borderColor: "#bfdbfe", borderWidth: 1,
          borderRadius: 12, padding: 14, marginBottom: 14,
        }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: "#1a73e8", alignItems: "center", justifyContent: "center" }}>
            <Check size={14} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[txt(700), { fontSize: 14, color: "#1e3a8a" }]}>
              Everything starts as PASS
            </Text>
            <Text style={[txt(500), { fontSize: 13, color: "#1e40af", marginTop: 3 }]}>
              Tap Fail on anything broken and snap a photo. N/A for items that don&apos;t apply to this truck.
            </Text>
            {failCount > 0 && (
              <Text style={[txt(700), { fontSize: 13, color: "#dc2626", marginTop: 6 }]}>
                {failCount} defect{failCount === 1 ? "" : "s"} flagged
              </Text>
            )}
          </View>
        </View>

        {/* Truck checklist */}
        {assetId && (
          <ChecklistBlock
            title="Truck inspection"
            sections={truckSections}
            items={items}
            setStatus={setStatus}
            setItemNotes={setItemNotes}
            onAddPhoto={(itemId) => addPhotoFor(itemId)}
            photos={photos}
            onRemovePhoto={removePhoto}
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
            onAddPhoto={(itemId) => addPhotoFor(itemId)}
            photos={photos}
            onRemovePhoto={removePhoto}
          />
        )}

        {/* General photos — odometer shot, nameplate, anything else */}
        <View style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
            <Text style={[txt(700), { flex: 1, fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 }]}>
              General photos (optional)
            </Text>
            <TouchableOpacity
              onPress={() => addPhotoFor(null)}
              style={{
                flexDirection: "row", alignItems: "center", gap: 4,
                paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
                backgroundColor: "#eff6ff",
              }}
            >
              <Plus size={14} color="#1a73e8" />
              <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]}>Add photo</Text>
            </TouchableOpacity>
          </View>
          {generalPhotos.length === 0 ? (
            <Text style={[txt(500), { fontSize: 12, color: "#9ca3af" }]}>
              Odometer, truck nameplate, anything you want a visual record of.
            </Text>
          ) : (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {generalPhotos.map(ph => (
                <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => removePhoto(ph.key)} />
              ))}
            </View>
          )}
        </View>

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
              fontSize: 15, color: "#111827", minHeight: 70,
              borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 8, padding: 12,
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
            backgroundColor: failCount > 0 ? "#dc2626" : "#1a73e8",
            paddingVertical: 16, borderRadius: 12,
            alignItems: "center", opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting
            ? <ActivityIndicator color="white" />
            : <Text style={[txt(700), { color: "white", fontSize: 16 }]}>
                {failCount > 0
                  ? `Submit with ${failCount} defect${failCount === 1 ? "" : "s"}`
                  : "Submit inspection"}
              </Text>}
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

      {/* photoTarget is set transiently while the picker sheet is open
          — keep it referenced so React doesn't drop the value mid-flow
          and confuse the upload metadata. */}
      {photoTarget && null}
    </KeyboardAvoidingView>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

function ChecklistBlock({
  title, sections, items, setStatus, setItemNotes, onAddPhoto, photos, onRemovePhoto,
}: {
  title: string;
  sections: { name: string; items: ChecklistItem[] }[];
  items: Record<string, ItemState>;
  setStatus:     (id: string, s: ItemStatus) => void;
  setItemNotes:  (id: string, n: string)     => void;
  onAddPhoto:    (itemId: string)            => void;
  photos:        PendingPhoto[];
  onRemovePhoto: (key: string)               => void;
}) {
  return (
    <View style={{ backgroundColor: "white", borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <Text style={[txt(700), { fontSize: 12, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
        {title}
      </Text>
      {sections.map((section, sIdx) => (
        <View key={section.name} style={{ marginTop: sIdx > 0 ? 14 : 0 }}>
          <Text style={[txt(700), { fontSize: 15, color: "#111827", marginBottom: 8 }]}>{section.name}</Text>
          {section.items.map(item => {
            const state = items[item.id];
            const isFail = state?.status === "fail";
            const itemPhotos = photos.filter(p => p.itemId === item.id);
            return (
              <View
                key={item.id}
                style={{
                  marginBottom: 10,
                  paddingVertical: 10, paddingHorizontal: 10,
                  borderRadius: 10,
                  backgroundColor: isFail ? "#fff5f5" : "transparent",
                  borderWidth: isFail ? 1 : 0,
                  borderColor: isFail ? "#fecaca" : "transparent",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38 }}>
                  <Text style={[txt(500), { fontSize: 15, color: "#111827", flex: 1 }]}>{item.label}</Text>
                  <StatusButton label="Pass" active={state?.status === "pass"} color="#16a34a" onPress={() => setStatus(item.id, "pass")} />
                  <StatusButton label="Fail" active={state?.status === "fail"} color="#dc2626" onPress={() => setStatus(item.id, "fail")} />
                  <StatusButton label="N/A"  active={state?.status === "na"}   color="#6b7280" onPress={() => setStatus(item.id, "na")} />
                </View>
                {isFail && (
                  <View style={{ marginTop: 10 }}>
                    <TextInput
                      value={state?.notes ?? ""}
                      onChangeText={(t) => setItemNotes(item.id, t)}
                      placeholder="Describe the issue…"
                      placeholderTextColor="#9ca3af"
                      multiline
                      style={[txt(500), {
                        fontSize: 14, color: "#111827",
                        borderWidth: 1, borderColor: "#fecaca", backgroundColor: "white",
                        borderRadius: 8, padding: 10, minHeight: 50, textAlignVertical: "top",
                      }]}
                    />
                    {/* Photo strip — tap camera to add, X to remove */}
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10, alignItems: "center" }}>
                      {itemPhotos.map(ph => (
                        <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => onRemovePhoto(ph.key)} />
                      ))}
                      <TouchableOpacity
                        onPress={() => onAddPhoto(item.id)}
                        style={{
                          width: 64, height: 64, borderRadius: 10,
                          borderWidth: 1.5, borderColor: "#fca5a5", borderStyle: "dashed",
                          backgroundColor: "white",
                          alignItems: "center", justifyContent: "center", gap: 2,
                        }}
                      >
                        <Camera size={18} color="#dc2626" />
                        <Text style={[txt(700), { fontSize: 9, color: "#dc2626" }]}>PHOTO</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function PhotoThumb({ uri, onRemove }: { uri: string; onRemove: () => void }) {
  return (
    <View style={{ width: 64, height: 64, borderRadius: 10, overflow: "hidden", position: "relative" }}>
      <Image source={{ uri }} style={{ width: 64, height: 64 }} resizeMode="cover" />
      <TouchableOpacity
        onPress={onRemove}
        style={{
          position: "absolute", top: 2, right: 2,
          width: 22, height: 22, borderRadius: 11,
          backgroundColor: "rgba(0,0,0,0.65)",
          alignItems: "center", justifyContent: "center",
        }}
      >
        <Trash2 size={12} color="white" />
      </TouchableOpacity>
    </View>
  );
}

function StatusButton({ label, active, color, onPress }: { label: string; active: boolean; color: string; onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8,
        backgroundColor: active ? color : "transparent",
        borderWidth: 1, borderColor: active ? color : "#e5e7eb",
        minWidth: 56, alignItems: "center",
      }}
    >
      <Text style={[txt(700), { fontSize: 13, color: active ? "white" : "#6b7280" }]}>{label}</Text>
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
        paddingVertical: 12, paddingHorizontal: 12,
        borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 10,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={[txt(500), { fontSize: 12, color: "#6b7280" }]}>{label}</Text>
        <Text style={[txt(700), { fontSize: 16, color: "#111827" }]}>{value}</Text>
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
              paddingHorizontal: 14, paddingVertical: 16,
              borderBottomWidth: 1, borderBottomColor: "#f3f4f6",
            }}
          >
            <Text style={[txt(600), { fontSize: 16, color: "#111827" }]}>{opt.label}</Text>
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
