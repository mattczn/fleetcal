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
  KeyboardAvoidingView, Platform, Image, findNodeHandle,
} from "react-native";
import {
  Truck, Container, ChevronDown, Check, X, ArrowLeft, AlertTriangle,
  Camera, Plus, Trash2, Search, Wrench, Sparkles, Video, Play,
} from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { railway, type InspectionItemPayload, type EquipmentHistory } from "@/lib/railway";
import { useTheme } from "@/lib/ThemeProvider";

/** Open work orders / known damage carried in from Step 1 so Step 3 can
 *  show the driver what's already reported before they create a report. */
type KnownDamage = EquipmentHistory["knownDamage"];

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

  // Condition — the Truck History module keys the cleanliness photo off
  // this exact item id ("cleanliness"). On a post-trip inspection the
  // driver must attach a cab/interior photo here before submit.
  { id: "cleanliness",      section: "Condition",             label: "Cab & interior clean" },

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

/** A failed checklist row handed to step 3 (maintenance reports). */
interface FailedItem {
  id:     string;
  label:  string;
  target: PhotoTarget;
  notes?: string;
  /** First photo the driver attached to this row, carried over to the
   *  maintenance report. null when they didn't take one. */
  photo:  PendingPhoto | null;
}

/** Default-everything-to-pass map. Built once per checklist so the
 *  initial render of 59 items doesn't need 59 effects to populate. */
function defaultsFor(list: ChecklistItem[]): Record<string, ItemState> {
  const out: Record<string, ItemState> = {};
  for (const it of list) out[it.id] = { status: "pass" };
  return out;
}

type PhotoTarget = "truck" | "trailer";

interface PendingPhoto {
  /** Stable client id so React can key the thumbnail before upload. */
  key:      string;
  uri:      string;
  fileName: string;
  mimeType: string;
  /** Checklist item this photo is attached to. null = general photo. */
  itemId:   string | null;
  /** Which piece of equipment this photo is about — derived from the
   *  checklist row for per-item photos, picked explicitly by the
   *  driver via the truck-section / trailer-section + button for
   *  general photos. Carried through to the upload so dispatch can
   *  group photos under the right asset in the inspection history. */
  target:   PhotoTarget;
}

interface PendingVideo {
  key:              string;
  uri:              string;
  fileName:         string;
  mimeType:         string;
  /** Duration Expo returned in seconds. Enforced ≤ 180 client-side even
   *  though iOS honors videoMaxDuration natively — Android is looser. */
  durationSeconds:  number;
}

interface Props {
  /** Initial asset to select. Defaults to the driver's currently
   *  assigned truck if known; null triggers a server lookup via
   *  /v1/driver/suggested-asset. */
  initialAssetId?: number | null;
  /** Pre-selected trailer (from Truck-History Step 1). null/undefined =
   *  no trailer. */
  initialTrailerId?: number | null;
  /** When true, the truck + trailer were chosen in Step 1 (the select-
   *  asset + review-history screen) and are LOCKED here — the internal
   *  equipment pickers are hidden and the trailer checklist shows iff a
   *  trailer was passed. */
  presetEquipment?: boolean;
  /** Pre-trip (start of shift, default) vs post-trip (end of shift).
   *  Post-trip additionally requires a cleanliness photo — see the
   *  submit gate below. */
  kind?:          "pre_trip" | "post_trip";
  /** Open work orders / known damage on the truck, threaded in from
   *  Step 1 so Step 3 (report defects) can show what's already reported
   *  before the driver creates a duplicate. */
  knownDamage?:   KnownDamage;
  /** Checklist items failed in a recent inspection (last 30 days) on the
   *  chosen truck — keyed by checklist item id → the most recent failing
   *  inspection's date + notes. Threaded from Step 1 (Truck-History flow);
   *  absent in the plain flow. Matching rows show a subtle amber caution. */
  recentlyFailed?: Record<string, { date: string; notes?: string | null }>;
  /** Driver's display name — used as the digital signature. */
  driverName:     string;
  onClose:        () => void;
  onSubmitted:    () => void;
}

export default function InspectionFormScreen({ initialAssetId, initialTrailerId, presetEquipment = false, kind = "pre_trip", knownDamage, recentlyFailed, driverName, onClose, onSubmitted }: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  // ── Equipment selection ───────────────────────────────────────────
  const [assets,        setAssets]        = useState<AssetOption[]>([]);
  const [trailers,      setTrailers]      = useState<TrailerOption[]>([]);
  const [assetId,       setAssetId]       = useState<number | null>(initialAssetId ?? null);
  const [trailerId,     setTrailerId]     = useState<number | null>(initialTrailerId ?? null);
  const [pickerOpen,    setPickerOpen]    = useState<"asset" | "trailer" | null>(null);
  const [optsLoading,   setOptsLoading]   = useState(true);
  // When Step 1 supplied a trailer, include it; otherwise the driver
  // opts in via the in-form checkbox (only shown when not preset).
  const [includeTrailer, setIncludeTrailer] = useState(initialTrailerId != null);

  // ── Checklist state — every item defaults to PASS so the driver
  //    only has to touch the ones that actually have a problem.
  const [items, setItems] = useState<Record<string, ItemState>>(() => ({
    ...defaultsFor(TRUCK_CHECKLIST),
    ...defaultsFor(TRAILER_CHECKLIST),
  }));
  const [notes,       setNotes]       = useState("");
  const [photos,      setPhotos]      = useState<PendingPhoto[]>([]);
  // Optional short walkaround video, filmed with the phone camera at
  // the end of the inspection. One per inspection is the intent (a
  // ~3-min narration of anything the checklist can't capture — engine
  // sound, brake feel, rattles). Kept as an array so a driver can drop
  // one and re-record without confusing state, but capped at 1.
  const [videos,      setVideos]      = useState<PendingVideo[]>([]);
  const [submitting,  setSubmitting]  = useState(false);

  // ── Cleanliness (standout top card) ───────────────────────────────
  // Pre-trip asks "Is the cab clean?" — a No sets the `cleanliness`
  // checklist item to `fail` (so cleanliness_flagged fires server-side)
  // and offers an optional photo. Post-trip always requires a cab photo.
  // `cabClean` is the pre-trip Yes/No answer (defaults to Yes/clean); it
  // is ignored on post-trip. Either way photos on this card upload with
  // itemId "cleanliness", which the server keys "last cleanliness photo"
  // off of.
  const [cabClean, setCabClean] = useState(true);

  // ── Step 3: maintenance reports for failed items ──────────────────
  // After a successful inspection submit, if any item failed we hand off
  // to an inline loop (MaintenanceStep) that walks the driver through
  // spinning up a maintenance report per defect. `maintStep` holds the
  // saved inspection id + the failed items to loop; null = not in step 3.
  const [maintStep, setMaintStep] = useState<{
    inspectionId: string;
    items: FailedItem[];
  } | null>(null);

  // ── Compliance signals — captured at mount, sent at submit.
  // openedAtRef is a ref (not state) so re-renders don't reset the
  // start time. gpsRef caches the mount-time read; we re-fetch at
  // submit so we get the most accurate coords for the actual signing
  // location.
  const openedAtRef = useRef<number>(Date.now());
  const gpsRef      = useRef<{ latitude: number; longitude: number } | null>(null);

  // Scroll-to-input on focus. When a driver taps the per-item notes
  // or general-notes TextInput, the iOS keyboard slides up and would
  // otherwise cover whatever field they're typing into. RN's built-in
  // scroll responder method positions the focused input ~120px above
  // the keyboard so they can actually see what they're writing.
  //
  // The 60ms delay is so the keyboard has started animating before
  // we measure — measuring too early gives the pre-keyboard layout
  // and the scroll undershoots.
  const scrollRef = useRef<ScrollView>(null);
  // Signature is `any` because RN's onFocus event type changed shape
  // across versions (TextInputFocusEventData vs ReactNativeElement
  // target) and findNodeHandle's strict overloads don't match either
  // cleanly. The runtime contract is stable: e.target is a node ref
  // findNodeHandle can resolve.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleInputFocus = useCallback((e: any) => {
    const tag = findNodeHandle(e?.target);
    if (tag == null) return;
    setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const responder: any = scrollRef.current?.getScrollResponder?.();
      responder?.scrollResponderScrollNativeHandleToKeyboard?.(tag, 120, true);
    }, 60);
  }, []);

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

  // In the Truck-History flow (presetEquipment) the cleanliness item is
  // rendered by the standout top card (CleanlinessCard), so it's dropped
  // from the normal checklist body — but it stays in TRUCK_CHECKLIST for
  // the submitted payload + failed-item collection. The plain (non-Truck-
  // History) flow keeps cleanliness as a regular checklist row, unchanged.
  const truckSections   = useMemo(
    () => groupBySection(presetEquipment ? TRUCK_CHECKLIST.filter(i => i.id !== "cleanliness") : TRUCK_CHECKLIST),
    [presetEquipment],
  );
  const trailerSections = useMemo(() => groupBySection(TRAILER_CHECKLIST), []);

  const setStatus = useCallback((id: string, status: ItemStatus) => {
    setItems(prev => ({ ...prev, [id]: { status, notes: prev[id]?.notes } }));
  }, []);

  const setItemNotes = useCallback((id: string, n: string) => {
    setItems(prev => ({ ...prev, [id]: { status: prev[id]?.status ?? "pass", notes: n } }));
  }, []);

  // Truck-History flow only: keep the `cleanliness` checklist item in sync
  // with the top card so it rides along in the submitted `items` (server
  // keys cleanliness_flagged off a `fail` status). Pre-trip: No → fail.
  // Post-trip: stays pass (the required cab photo is the signal there, not
  // a fail). The plain flow leaves cleanliness as a normal checklist row.
  useEffect(() => {
    if (!presetEquipment) return;
    const status: ItemStatus = kind === "pre_trip" && !cabClean ? "fail" : "pass";
    setItems(prev => (prev.cleanliness?.status === status
      ? prev
      : { ...prev, cleanliness: { status, notes: prev.cleanliness?.notes } }));
  }, [presetEquipment, kind, cabClean]);

  // ── Photos ────────────────────────────────────────────────────────
  // Per-item photo flow: tapping the camera on a Fail row pops the
  // standard Take-Photo / Choose-from-Library sheet. Photos are queued
  // locally (PendingPhoto) and uploaded sequentially after the report
  // row is created, so each upload knows the inspection id.
  //
  // target = "truck" | "trailer" is required so dispatch can group
  // photos under the right asset. For per-item photos it's derived
  // from the checklist block; for general photos it's picked
  // explicitly by which "+ Add photo" button the driver tapped.
  const addPhotoFor = useCallback(async (target: PhotoTarget, itemId: string | null) => {
    if (photos.length >= 12) {
      Alert.alert("Limit reached", "Up to 12 photos per inspection.");
      return;
    }
    Alert.alert(
      itemId
        ? `Add photo (${target})`
        : `Add general ${target} photo`,
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
              target,
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
                target,
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

  // ── Optional walkaround video ────────────────────────────────────
  // Record with the native camera in video mode, 3-min cap. iOS
  // enforces videoMaxDuration natively; Android doesn't reliably, so
  // we also reject the clip client-side if it comes back long.
  const MAX_VIDEO_SECONDS = 180;
  const recordVideo = useCallback(async () => {
    if (videos.length >= 1) {
      Alert.alert("Video recorded", "Remove the current video before recording a new one.");
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Camera", "Enable camera access in Settings.");
      return;
    }
    const res = await ImagePicker.launchCameraAsync({
      mediaTypes:       ImagePicker.MediaTypeOptions.Videos,
      videoMaxDuration: MAX_VIDEO_SECONDS,
      // Medium (1) = ~480p on iOS — good enough to see a rattle or a
      // brake pedal, keeps a 3-min clip in the ~30-60MB range for
      // cellular upload. Bump to High (0) later if quality complaints
      // come in. On Android this maps to the middle quality bucket.
      videoQuality:     ImagePicker.UIImagePickerControllerQualityType.Medium,
    });
    if (res.canceled) return;
    const a = res.assets[0];
    if (!a) return;
    // Expo returns duration in ms on video assets. Guard against
    // Android-side missing duration by falling back to a sane default.
    const durMs = typeof a.duration === "number" ? a.duration : 0;
    const durSec = Math.round(durMs / 1000);
    if (durSec > MAX_VIDEO_SECONDS) {
      Alert.alert(
        "Video too long",
        `Videos are limited to ${MAX_VIDEO_SECONDS / 60} minutes. This clip is ${Math.round(durSec / 60)} min.`,
      );
      return;
    }
    setVideos([{
      key:             `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      uri:             a.uri,
      fileName:        a.fileName ?? `inspection-${Date.now()}.mp4`,
      mimeType:        a.mimeType ?? "video/mp4",
      durationSeconds: durSec > 0 ? durSec : 1,
    }]);
  }, [videos.length]);

  const removeVideo = useCallback((key: string) => {
    setVideos(v => v.filter(x => x.key !== key));
  }, []);

  // ── Submit ────────────────────────────────────────────────────────
  // Two-step: tapping the bottom button opens a confirm alert ("Submit
  // this inspection?") with Confirm / Keep editing. Submission is
  // irreversible per DOT recordkeeping, so an accidental tap shouldn't
  // be able to lock in a rubber-stamp.
  const performSubmit = useCallback(async () => {
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

    // Collect the failed rows for step 3 (maintenance reports). Each one
    // remembers whether it's a truck- or trailer-side defect (so the
    // report targets the right equipment) and the first photo the driver
    // attached (carried over to the maintenance report).
    const buildFailedItems = (): FailedItem[] => {
      const out: FailedItem[] = [];
      const collect = (defs: ChecklistItem[], target: PhotoTarget) => {
        for (const d of defs) {
          // Cleanliness is a condition/accountability signal, not a mechanical
          // defect — a dirty cab shouldn't prompt a maintenance work order.
          if (d.id === "cleanliness") continue;
          if (items[d.id]?.status !== "fail") continue;
          const photo = photos.find(p => p.itemId === d.id) ?? null;
          out.push({ id: d.id, label: d.label, target, notes: items[d.id]?.notes, photo });
        }
      };
      if (assetId) collect(TRUCK_CHECKLIST, "truck");
      if (includeTrailer && trailerId) collect(TRAILER_CHECKLIST, "trailer");
      return out;
    };

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
        kind,
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
      // some attachments. The cleanliness photo carries itemId
      // "cleanliness" here (it's a per-item photo on the cleanliness
      // row) so the server's "last cleanliness photo" query finds it.
      const photoFailures: string[] = [];
      for (const ph of photos) {
        try {
          const form = new FormData();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: ph.uri, name: ph.fileName, type: ph.mimeType } as any);
          if (ph.itemId) form.append("itemId", ph.itemId);
          form.append("target", ph.target);
          await railway.uploadInspectionPhoto(inspection.id, form);
        } catch (err) {
          console.warn("[inspection] photo upload failed:", err);
          photoFailures.push(ph.fileName);
        }
      }

      // Video upload — same endpoint, extra multipart fields tell the
      // server this is a video. Failing here doesn't roll back the
      // inspection; the driver keeps the local file (they can retry
      // from the toast).
      const videoFailures: string[] = [];
      for (const vd of videos) {
        try {
          const form = new FormData();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: vd.uri, name: vd.fileName, type: vd.mimeType } as any);
          form.append("mediaKind",       "video");
          form.append("durationSeconds", String(vd.durationSeconds));
          await railway.uploadInspectionPhoto(inspection.id, form);
        } catch (err) {
          console.warn("[inspection] video upload failed:", err);
          videoFailures.push(vd.fileName);
        }
      }

      if (photoFailures.length + videoFailures.length > 0) {
        const bits: string[] = [];
        if (photoFailures.length > 0) bits.push(`${photoFailures.length} photo${photoFailures.length === 1 ? "" : "s"}`);
        if (videoFailures.length > 0) bits.push(`${videoFailures.length} video`);
        Alert.alert("Submitted", `Inspection saved, but ${bits.join(" + ")} failed to upload.`);
      }

      // Step 3 — if the driver flagged any defects, offer to spin up a
      // maintenance report per failed item before we close. We know the
      // asset/trailer from the inspection and carry over any photo the
      // driver already took for that row. If nothing failed, close now.
      const failed = buildFailedItems();
      if (failed.length > 0) {
        setMaintStep({ inspectionId: inspection.id, items: failed });
      } else {
        onSubmitted();
      }
    } catch (e) {
      console.error("[InspectionForm] submit failed:", e);
      Alert.alert("Submit failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [assetId, trailerId, includeTrailer, kind, items, notes, driverName, photos, videos, onSubmitted]);

  const failCount = useMemo(
    () => Object.values(items).filter(s => s.status === "fail").length,
    [items],
  );

  // Wrapper that runs validation, then pops a confirm Alert before
  // actually firing the submit. Validation lives here (not in
  // performSubmit) so the alert is only ever shown for an inspection
  // that's actually going to go through.
  // Post-trip inspections require a cleanliness photo — the Truck History
  // module needs a cab/interior shot at end of shift. Keyed on the
  // "cleanliness" checklist row so the photo uploads with itemId
  // "cleanliness" (see performSubmit).
  const hasCleanlinessPhoto = useMemo(
    () => photos.some(p => p.itemId === "cleanliness"),
    [photos],
  );

  const handleSubmit = useCallback(() => {
    if (!assetId && !(includeTrailer && trailerId)) {
      Alert.alert("Pick equipment", "Select a truck (and optionally a trailer) to inspect.");
      return;
    }
    if (kind === "post_trip" && !hasCleanlinessPhoto) {
      Alert.alert(
        "Cleanliness photo required",
        "Post-trip inspections need a photo of the cab & interior. Add it on the Cab cleanliness card at the top.",
      );
      return;
    }
    const truckPart   = assetId && selectedAsset ? truckLabel(selectedAsset.name, selectedAsset.unit) : "";
    const trailerPart = includeTrailer && selectedTrailer ? trailerLabel(selectedTrailer.name, selectedTrailer.trailerNumber) : "";
    const equipmentLine = [truckPart, trailerPart].filter(Boolean).join(" + ");
    const defectLine    = failCount > 0
      ? `\n\n${failCount} defect${failCount === 1 ? "" : "s"} will be reported.`
      : "";
    Alert.alert(
      "Submit this inspection?",
      `${equipmentLine}${defectLine}\n\nOnce submitted, the report is final.`,
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Confirm",      style: "default", onPress: () => void performSubmit() },
      ],
      { cancelable: true },
    );
  }, [assetId, trailerId, includeTrailer, kind, hasCleanlinessPhoto, selectedAsset, selectedTrailer, failCount, performSubmit]);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface }}>
        <TouchableOpacity onPress={onClose} style={{ padding: 6, marginLeft: -6 }}>
          <ArrowLeft size={22} color={C.t1} />
        </TouchableOpacity>
        <Text style={[txt(700), { fontSize: 17, color: C.t1 }]}>
          {kind === "post_trip" ? "Post-Trip Inspection" : "Pre-Trip Inspection"}
        </Text>
        <View style={{ flex: 1 }} />
        <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{driverName}</Text>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1, backgroundColor: C.bg }}
        contentContainerStyle={{ padding: 14, paddingBottom: 100 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Equipment — when preset (Truck-History flow), the truck +
            trailer were chosen in Step 1 and are LOCKED; we show a read-
            only summary instead of the pickers. Otherwise the standard
            in-form pickers. */}
        {presetEquipment ? (
          <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
              Equipment
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <Truck size={16} color={ACCENT} />
              <Text style={[txt(700), { fontSize: 16, color: C.t1 }]}>
                {selectedAsset ? truckLabel(selectedAsset.name, selectedAsset.unit) : (optsLoading ? "Loading…" : "Truck")}
              </Text>
            </View>
            {includeTrailer && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 10 }}>
                <Container size={16} color={ACCENT} />
                <Text style={[txt(700), { fontSize: 16, color: C.t1 }]}>
                  {selectedTrailer ? trailerLabel(selectedTrailer.name, selectedTrailer.trailerNumber) : "Trailer"}
                </Text>
              </View>
            )}
          </View>
        ) : (
          <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
            <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
              Equipment
            </Text>
            <PickerRow
              icon={<Truck size={16} color={ACCENT} />}
              label="Truck"
              value={selectedAsset ? truckLabel(selectedAsset.name, selectedAsset.unit) : "Pick a truck"}
              onPress={() => setPickerOpen("asset")}
              disabled={optsLoading}
            />
            <View style={{ height: 10 }} />
            <TouchableOpacity
              onPress={() => setIncludeTrailer(t => !t)}
              style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}
            >
              <View style={{
                width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: ACCENT,
                alignItems: "center", justifyContent: "center",
                backgroundColor: includeTrailer ? ACCENT : C.surface,
                marginRight: 8,
              }}>
                {includeTrailer && <Check size={12} color="white" />}
              </View>
              <Text style={[txt(500), { fontSize: 14, color: C.t2 }]}>Inspecting a trailer too</Text>
            </TouchableOpacity>
            {includeTrailer && (
              <View style={{ marginTop: 8 }}>
                <PickerRow
                  icon={<Container size={16} color={ACCENT} />}
                  label="Trailer"
                  value={selectedTrailer ? trailerLabel(selectedTrailer.name, selectedTrailer.trailerNumber) : "Pick a trailer"}
                  onPress={() => setPickerOpen("trailer")}
                  disabled={optsLoading}
                />
              </View>
            )}
          </View>
        )}

        {/* Cleanliness — standout colored card ABOVE the checklist, in the
            Truck-History flow only. Feeds the same `cleanliness` item into
            the payload (see the sync effect) and any photo uploads with
            itemId "cleanliness". The plain flow keeps cleanliness inline in
            the checklist (with the original post-trip required-photo strip). */}
        {presetEquipment && (
          <CleanlinessCard
            kind={kind}
            cabClean={cabClean}
            onSetClean={setCabClean}
            photos={photos.filter(p => p.itemId === "cleanliness")}
            onAddPhoto={() => addPhotoFor("truck", "cleanliness")}
            onRemovePhoto={removePhoto}
          />
        )}

        {/* Helper banner — "default is pass, only mark failures" */}
        <View style={{
          flexDirection: "row", alignItems: "flex-start", gap: 10,
          backgroundColor: C.blueBg, borderColor: C.blue, borderWidth: 1,
          borderRadius: 12, padding: 14, marginBottom: 14,
        }}>
          <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: ACCENT, alignItems: "center", justifyContent: "center" }}>
            <Check size={14} color="white" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[txt(700), { fontSize: 14, color: C.blueInk }]}>
              Everything starts as PASS
            </Text>
            <Text style={[txt(500), { fontSize: 13, color: C.blueInk, marginTop: 3 }]}>
              Tap Fail on anything broken and snap a photo. N/A for items that don&apos;t apply to this truck.
            </Text>
            {failCount > 0 && (
              <Text style={[txt(700), { fontSize: 13, color: C.red, marginTop: 6 }]}>
                {failCount} defect{failCount === 1 ? "" : "s"} flagged
              </Text>
            )}
          </View>
        </View>

        {/* Truck checklist — general photos block lives inside, tagged
            target="truck" so dispatch can attribute them correctly. */}
        {assetId && (
          <ChecklistBlock
            title="Truck inspection"
            target="truck"
            sections={truckSections}
            items={items}
            setStatus={setStatus}
            setItemNotes={setItemNotes}
            onInputFocus={handleInputFocus}
            onAddPhoto={(itemId) => addPhotoFor("truck", itemId)}
            onAddGeneralPhoto={() => addPhotoFor("truck", null)}
            photos={photos.filter(p => p.target === "truck")}
            onRemovePhoto={removePhoto}
            recentlyFailed={recentlyFailed}
            // Plain flow only: post-trip cleanliness photo strip stays
            // inline on the checklist row. The Truck-History flow moves
            // this to CleanlinessCard, so suppress it there.
            photoAlwaysItemId={!presetEquipment && kind === "post_trip" ? "cleanliness" : null}
          />
        )}

        {/* Trailer checklist — same structure, target="trailer". */}
        {includeTrailer && trailerId && (
          <ChecklistBlock
            title="Trailer inspection"
            target="trailer"
            sections={trailerSections}
            items={items}
            setStatus={setStatus}
            setItemNotes={setItemNotes}
            onInputFocus={handleInputFocus}
            onAddPhoto={(itemId) => addPhotoFor("trailer", itemId)}
            onAddGeneralPhoto={() => addPhotoFor("trailer", null)}
            photos={photos.filter(p => p.target === "trailer")}
            onRemovePhoto={removePhoto}
            recentlyFailed={recentlyFailed}
          />
        )}

        {/* General notes */}
        <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }]}>
            General notes (optional)
          </Text>
          <TextInput
            value={notes}
            onChangeText={setNotes}
            onFocus={handleInputFocus}
            placeholder="Anything else worth noting…"
            placeholderTextColor={C.t4}
            multiline
            style={[txt(500), {
              fontSize: 15, color: C.t1, minHeight: 70,
              borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12,
              textAlignVertical: "top",
            }]}
          />
        </View>

        {/* Walkaround video (optional) — short clip for anything
            photos can't show (engine sound, brake feel, rattle). */}
        <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
          <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 }]}>
            Walkaround video (optional)
          </Text>
          <Text style={[txt(500), { fontSize: 12, color: C.t3, marginBottom: 10 }]}>
            Up to 3 minutes. Filmed with the phone camera.
          </Text>
          {videos.length === 0 ? (
            <TouchableOpacity
              onPress={recordVideo}
              style={{
                flexDirection: "row", alignItems: "center", justifyContent: "center",
                borderWidth: 1, borderColor: C.border, borderStyle: "dashed",
                borderRadius: 10, paddingVertical: 14, gap: 8,
              }}
            >
              <Video size={18} color={C.t2} />
              <Text style={[txt(600), { fontSize: 14, color: C.t2 }]}>Record video</Text>
            </TouchableOpacity>
          ) : (
            videos.map(v => (
              <View
                key={v.key}
                style={{
                  flexDirection: "row", alignItems: "center",
                  borderWidth: 1, borderColor: C.border, borderRadius: 10,
                  padding: 12, gap: 12,
                }}
              >
                <View style={{
                  width: 44, height: 44, borderRadius: 8,
                  backgroundColor: C.t1 + "12",
                  alignItems: "center", justifyContent: "center",
                }}>
                  <Play size={20} color={C.t1} fill={C.t1} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[txt(700), { fontSize: 14, color: C.t1 }]}>
                    Video recorded
                  </Text>
                  <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 2 }]}>
                    {Math.floor(v.durationSeconds / 60)}:{String(v.durationSeconds % 60).padStart(2, "0")}
                  </Text>
                </View>
                <TouchableOpacity
                  onPress={() => removeVideo(v.key)}
                  hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}
                >
                  <Trash2 size={18} color={C.red} />
                </TouchableOpacity>
              </View>
            ))
          )}
        </View>

        {/* Signature line */}
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 14 }}>
          <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>Signed by </Text>
          <Text style={[txt(700), { fontSize: 13, color: C.t1 }]}>{driverName}</Text>
        </View>
      </ScrollView>

      {/* Submit button (sticky) */}
      <View style={{ padding: 14, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.surface }}>
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting}
          style={{
            backgroundColor: failCount > 0 ? C.red : ACCENT,
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
        />
      )}

      {/* Step 3 — maintenance reports for failed items. Full-screen
          overlay that loops the defects; when the driver finishes (or
          skips all), it closes the whole form via onSubmitted. */}
      {maintStep && (
        <MaintenanceStep
          inspectionId={maintStep.inspectionId}
          items={maintStep.items}
          assetId={assetId}
          trailerId={includeTrailer ? trailerId : null}
          knownDamage={knownDamage}
          onDone={() => { setMaintStep(null); onSubmitted(); }}
        />
      )}

    </KeyboardAvoidingView>
  );
}

// ─── Subcomponents ────────────────────────────────────────────────────

/**
 * MaintenanceStep — step 3 of the pre/post-trip flow. After the
 * inspection is saved, if any items failed we walk the driver through
 * one lightweight card per defect: a pre-filled, editable description and
 * a Create / Skip choice. "Create report" fires
 * railway.submitMaintenanceReport (source:"inspection", tying it back to
 * the inspection + item) and, if the driver took a photo for that row,
 * uploads it to the new report. This is deliberately inline — NOT the
 * persistent MaintenanceFormScreen — so the driver stays in one flow.
 */
function MaintenanceStep({
  inspectionId, items, assetId, trailerId, knownDamage, onDone,
}: {
  inspectionId: string;
  items:        FailedItem[];
  assetId:      number | null;
  trailerId:    number | null;
  /** Open work orders / known damage on the truck (from Step 1). Shown
   *  above the defect card so the driver can see what's already reported
   *  before creating a possible duplicate. */
  knownDamage?: KnownDamage;
  onDone:       () => void;
}) {
  const { C, ACCENT } = useTheme();
  const [idx, setIdx]           = useState(0);
  const [desc, setDesc]         = useState("");
  const [busy, setBusy]         = useState(false);

  const current = items[idx] ?? null;
  const openDamage = knownDamage ?? [];

  // Reset the editable description each time we advance to a new defect.
  useEffect(() => {
    if (current) setDesc(`${current.label} failed inspection`);
  }, [idx, current]);

  const advance = useCallback(() => {
    if (idx + 1 >= items.length) onDone();
    else setIdx(i => i + 1);
  }, [idx, items.length, onDone]);

  const createReport = useCallback(async () => {
    if (!current || busy) return;
    setBusy(true);
    try {
      // Target the truck for truck-side defects, the trailer for
      // trailer-side ones — determined by the failed item's `target`.
      const target = current.target === "trailer"
        ? { trailerId: trailerId ?? undefined }
        : { assetId:   assetId   ?? undefined };
      const { report } = await railway.submitMaintenanceReport({
        ...target,
        description:        desc.trim() || `${current.label} failed inspection`,
        source:             "inspection",
        inspectionReportId: inspectionId,
        inspectionItemId:   current.id,
      });
      // Carry over the inspection photo for this row, if any.
      if (current.photo) {
        try {
          const form = new FormData();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          form.append("file", { uri: current.photo.uri, name: current.photo.fileName, type: current.photo.mimeType } as any);
          await railway.uploadMaintenancePhoto(report.id, form);
        } catch (err) {
          console.warn("[inspection] maintenance photo upload failed:", err);
        }
      }
      advance();
    } catch (e) {
      console.error("[MaintenanceStep] create failed:", e);
      Alert.alert("Couldn't create report", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }, [current, busy, desc, assetId, trailerId, inspectionId, advance]);

  if (!current) return null;

  return (
    <View style={{ position: "absolute", inset: 0, backgroundColor: C.bg }}>
      {/* Header */}
      <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.surface }}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: C.red, alignItems: "center", justifyContent: "center" }}>
          <Wrench size={16} color="white" />
        </View>
        <Text style={[txt(700), { fontSize: 17, color: C.t1, flex: 1 }]}>Report defects</Text>
        <Text style={[txt(500), { fontSize: 12, color: C.t3 }]}>{idx + 1} of {items.length}</Text>
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14 }} keyboardShouldPersistTaps="handled">
        {/* Already-open work orders on this truck (from Step 1) — so the
            driver can see if the defect is already reported before
            creating a duplicate. */}
        {openDamage.length > 0 && (
          <View style={{ backgroundColor: C.amberBg, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: C.amber, marginBottom: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <Wrench size={15} color={C.amberInk} />
              <Text style={[txt(700), { fontSize: 13, color: C.amberInk, flex: 1 }]}>
                Already open on this truck ({openDamage.length})
              </Text>
            </View>
            <Text style={[txt(500), { fontSize: 12, color: C.amberInk, marginBottom: 8 }]}>
              Check these before reporting — it may already be logged.
            </Text>
            {openDamage.map((d) => (
              <View key={`${d.source}-${d.id}`} style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, marginTop: 4 }}>
                <Text style={[txt(700), { fontSize: 13, color: C.t1, flex: 1 }]}>
                  {d.title ?? d.description ?? "Damage"}
                  {d.outOfService ? " · OOS" : ""}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: C.border }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <AlertTriangle size={16} color={C.red} />
            <Text style={[txt(700), { flex: 1, fontSize: 16, color: C.t1 }]}>
              Create a maintenance report for {current.label}?
            </Text>
          </View>

          {current.photo && (
            <View style={{ marginBottom: 12 }}>
              <Image source={{ uri: current.photo.uri }} style={{ width: 96, height: 96, borderRadius: 10 }} resizeMode="cover" />
              <Text style={[txt(500), { fontSize: 11, color: C.t4, marginTop: 4 }]}>Photo from inspection will be attached.</Text>
            </View>
          )}

          <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }]}>
            Description
          </Text>
          <TextInput
            value={desc}
            onChangeText={setDesc}
            placeholder="Describe the issue…"
            placeholderTextColor={C.t4}
            multiline
            style={[txt(500), {
              fontSize: 15, color: C.t1, minHeight: 80,
              borderWidth: 1, borderColor: C.border, borderRadius: 8, padding: 12,
              textAlignVertical: "top",
            }]}
          />

          <View style={{ flexDirection: "row", gap: 10, marginTop: 16 }}>
            <TouchableOpacity
              onPress={advance}
              disabled={busy}
              style={{ flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center", borderWidth: 1, borderColor: C.border, backgroundColor: C.surface }}
            >
              <Text style={[txt(700), { fontSize: 15, color: C.t2 }]}>Skip</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => void createReport()}
              disabled={busy}
              style={{ flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: ACCENT, opacity: busy ? 0.6 : 1 }}
            >
              {busy ? <ActivityIndicator color="white" /> : <Text style={[txt(700), { fontSize: 15, color: "white" }]}>Create report</Text>}
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/**
 * CleanlinessCard — the standout colored card that sits ABOVE the
 * checklist and replaces the plain "Cab & interior clean" checklist row.
 *
 *   - Pre-trip:  "Is the cab clean?" Yes / No. A No flags the cleanliness
 *                item as `fail` (via the parent's sync effect) and offers
 *                an OPTIONAL "how dirty it is" photo.
 *   - Post-trip: a REQUIRED "Photo of inside the cab" — submit is blocked
 *                until one is attached (parent's hasCleanlinessPhoto gate).
 *
 * Photos added here always carry itemId "cleanliness", which the server
 * keys the "last cleanliness photo" reference off of.
 */
function CleanlinessCard({
  kind, cabClean, onSetClean, photos, onAddPhoto, onRemovePhoto,
}: {
  kind:          "pre_trip" | "post_trip";
  cabClean:      boolean;
  onSetClean:    (v: boolean) => void;
  photos:        PendingPhoto[];
  onAddPhoto:    () => void;
  onRemovePhoto: (key: string) => void;
}) {
  const { C, ACCENT } = useTheme();
  const isPost = kind === "post_trip";
  const photoMissing = isPost && photos.length === 0;
  // Card tone: post-trip is neutral/blue until the required photo lands;
  // pre-trip goes red when the driver says the cab is dirty.
  const dirty = !isPost && !cabClean;
  const bg     = dirty ? C.redBg : isPost ? C.blueBg : C.greenBg;
  const border = dirty ? C.red   : isPost ? C.blue   : C.green;
  const ink    = dirty ? C.redInk : isPost ? C.blueInk : C.greenInk;

  return (
    <View style={{ backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <Sparkles size={16} color={ink} />
        <Text style={[txt(800), { fontSize: 15, color: ink }]}>Cab cleanliness</Text>
      </View>

      {isPost ? (
        <>
          <Text style={[txt(500), { fontSize: 13, color: ink, marginBottom: 12 }]}>
            Photo of inside the cab — required to submit a post-trip inspection.
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            {photos.map(ph => (
              <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => onRemovePhoto(ph.key)} />
            ))}
            <TouchableOpacity
              onPress={onAddPhoto}
              style={{
                width: 64, height: 64, borderRadius: 10,
                borderWidth: 1.5, borderColor: photoMissing ? C.amberInk : border, borderStyle: "dashed",
                backgroundColor: C.surface,
                alignItems: "center", justifyContent: "center", gap: 2,
              }}
            >
              <Camera size={18} color={photoMissing ? C.amberInk : ACCENT} />
              <Text style={[txt(700), { fontSize: 9, color: photoMissing ? C.amberInk : ACCENT }]}>PHOTO</Text>
            </TouchableOpacity>
          </View>
          {photoMissing && (
            <Text style={[txt(600), { fontSize: 12, color: C.amberInk, marginTop: 8 }]}>
              Required — add a cab & interior shot.
            </Text>
          )}
        </>
      ) : (
        <>
          <Text style={[txt(600), { fontSize: 14, color: ink, marginBottom: 12 }]}>Is the cab clean?</Text>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <TouchableOpacity
              onPress={() => onSetClean(true)}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center",
                backgroundColor: cabClean ? C.green : C.surface,
                borderWidth: 1, borderColor: cabClean ? C.green : C.border,
              }}
            >
              <Text style={[txt(700), { fontSize: 15, color: cabClean ? "white" : C.t2 }]}>Yes</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onSetClean(false)}
              style={{
                flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center",
                backgroundColor: !cabClean ? C.red : C.surface,
                borderWidth: 1, borderColor: !cabClean ? C.red : C.border,
              }}
            >
              <Text style={[txt(700), { fontSize: 15, color: !cabClean ? "white" : C.t2 }]}>No</Text>
            </TouchableOpacity>
          </View>
          {/* Dirty → optional photo (not required to submit). */}
          {dirty && (
            <View style={{ marginTop: 12 }}>
              <Text style={[txt(600), { fontSize: 12, color: ink, marginBottom: 8 }]}>
                Add a photo of how dirty it is (optional)
              </Text>
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {photos.map(ph => (
                  <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => onRemovePhoto(ph.key)} />
                ))}
                <TouchableOpacity
                  onPress={onAddPhoto}
                  style={{
                    width: 64, height: 64, borderRadius: 10,
                    borderWidth: 1.5, borderColor: border, borderStyle: "dashed",
                    backgroundColor: C.surface,
                    alignItems: "center", justifyContent: "center", gap: 2,
                  }}
                >
                  <Camera size={18} color={C.red} />
                  <Text style={[txt(700), { fontSize: 9, color: C.red }]}>PHOTO</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </>
      )}
    </View>
  );
}

function ChecklistBlock({
  title, target, sections, items, setStatus, setItemNotes, onInputFocus, onAddPhoto, onAddGeneralPhoto, photos, onRemovePhoto, photoAlwaysItemId = null, recentlyFailed,
}: {
  title: string;
  target: PhotoTarget;
  sections: { name: string; items: ChecklistItem[] }[];
  items: Record<string, ItemState>;
  setStatus:          (id: string, s: ItemStatus) => void;
  setItemNotes:       (id: string, n: string)     => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onInputFocus:       (e: any)                    => void;
  onAddPhoto:         (itemId: string)            => void;
  onAddGeneralPhoto:  ()                          => void;
  photos:             PendingPhoto[];
  onRemovePhoto:      (key: string)               => void;
  /** Item id that always shows a (required) photo strip regardless of
   *  pass/fail — the plain (non-Truck-History) flow's post-trip
   *  cleanliness shot. The Truck-History flow uses CleanlinessCard. */
  photoAlwaysItemId?: string | null;
  /** Checklist items failed in a recent inspection on this equipment,
   *  keyed by item id. Matching rows show a small amber "review" caution. */
  recentlyFailed?: Record<string, { date: string; notes?: string | null }>;
}) {
  const { C, SHADOW, ACCENT } = useTheme();
  // Photos with no itemId are the "general" ones for this piece of
  // equipment — odometer shot, nameplate, the dirty wiring under the
  // dash, anything the driver wants on record but doesn't tie to a
  // single checklist row.
  const generalPhotos = photos.filter(p => p.itemId == null);
  return (
    <View style={{ backgroundColor: C.surface, borderRadius: 12, padding: 14, marginBottom: 14 }}>
      <Text style={[txt(700), { fontSize: 12, color: C.t3, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }]}>
        {title}
      </Text>
      {sections.map((section, sIdx) => (
        <View key={section.name} style={{ marginTop: sIdx > 0 ? 14 : 0 }}>
          <Text style={[txt(700), { fontSize: 15, color: C.t1, marginBottom: 8 }]}>{section.name}</Text>
          {section.items.map(item => {
            const state = items[item.id];
            const isFail = state?.status === "fail";
            const itemPhotos = photos.filter(p => p.itemId === item.id);
            // A required photo row (plain-flow post-trip cleanliness) shows
            // its photo strip even on PASS and flags amber until attached.
            const isRequiredPhoto = photoAlwaysItemId === item.id;
            const requiredMissing = isRequiredPhoto && !isFail && itemPhotos.length === 0;
            // Failed on this truck in a recent inspection → nudge the driver
            // to re-check the row (subtle amber note, not blocking).
            const priorFail = recentlyFailed?.[item.id];
            return (
              <View
                key={item.id}
                style={{
                  marginBottom: 10,
                  paddingVertical: 10, paddingHorizontal: 10,
                  borderRadius: 10,
                  backgroundColor: isFail ? C.redBg : "transparent",
                  borderWidth: isFail || requiredMissing ? 1 : 0,
                  borderColor: isFail ? C.red : requiredMissing ? C.amberInk : "transparent",
                }}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 38 }}>
                  <Text style={[txt(500), { fontSize: 15, color: C.t1, flex: 1 }]}>{item.label}</Text>
                  <StatusButton label="Pass" active={state?.status === "pass"} color={C.green} onPress={() => setStatus(item.id, "pass")} />
                  <StatusButton label="Fail" active={state?.status === "fail"} color={C.red} onPress={() => setStatus(item.id, "fail")} />
                  <StatusButton label="N/A"  active={state?.status === "na"}   color={C.t3} onPress={() => setStatus(item.id, "na")} />
                </View>
                {priorFail && (
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
                    <AlertTriangle size={13} color={C.amberInk} />
                    <Text style={[txt(600), { fontSize: 12, color: C.amberInk, flex: 1 }]}>
                      Flagged in a recent inspection ({fmtShortDate(priorFail.date)}) — review
                    </Text>
                  </View>
                )}
                {isRequiredPhoto && !isFail && (
                  <View style={{ marginTop: 10 }}>
                    <Text style={[txt(600), { fontSize: 12, color: requiredMissing ? C.amberInk : C.t3, marginBottom: 8 }]}>
                      {requiredMissing ? "Photo required — add a cab & interior shot" : "Cleanliness photo attached"}
                    </Text>
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      {itemPhotos.map(ph => (
                        <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => onRemovePhoto(ph.key)} />
                      ))}
                      <TouchableOpacity
                        onPress={() => onAddPhoto(item.id)}
                        style={{
                          width: 64, height: 64, borderRadius: 10,
                          borderWidth: 1.5, borderColor: requiredMissing ? C.amberInk : C.border, borderStyle: "dashed",
                          backgroundColor: C.surface,
                          alignItems: "center", justifyContent: "center", gap: 2,
                        }}
                      >
                        <Camera size={18} color={requiredMissing ? C.amberInk : C.t3} />
                        <Text style={[txt(700), { fontSize: 9, color: requiredMissing ? C.amberInk : C.t3 }]}>PHOTO</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
                {isFail && (
                  <View style={{ marginTop: 10 }}>
                    <TextInput
                      value={state?.notes ?? ""}
                      onChangeText={(t) => setItemNotes(item.id, t)}
                      onFocus={onInputFocus}
                      placeholder="Describe the issue…"
                      placeholderTextColor={C.t4}
                      multiline
                      style={[txt(500), {
                        fontSize: 14, color: C.t1,
                        borderWidth: 1, borderColor: C.red, backgroundColor: C.surface,
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
                          borderWidth: 1.5, borderColor: C.red, borderStyle: "dashed",
                          backgroundColor: C.surface,
                          alignItems: "center", justifyContent: "center", gap: 2,
                        }}
                      >
                        <Camera size={18} color={C.red} />
                        <Text style={[txt(700), { fontSize: 9, color: C.red }]}>PHOTO</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )}
              </View>
            );
          })}
        </View>
      ))}

      {/* General photos for THIS piece of equipment — separate block
          so a truck+trailer combined inspection ends up with two
          distinct buckets. target prop is set in the parent so every
          photo added here is tagged correctly without re-derivation. */}
      <View style={{ marginTop: 18, paddingTop: 14, borderTopWidth: 1, borderTopColor: C.borderSoft }}>
        <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
          <Text style={[txt(700), { flex: 1, fontSize: 13, color: C.t2 }]}>
            General {target} photos
          </Text>
          <TouchableOpacity
            onPress={onAddGeneralPhoto}
            style={{
              flexDirection: "row", alignItems: "center", gap: 4,
              paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8,
              backgroundColor: C.blueBg,
            }}
          >
            <Plus size={14} color={ACCENT} />
            <Text style={[txt(700), { fontSize: 12, color: ACCENT }]}>Add photo</Text>
          </TouchableOpacity>
        </View>
        {generalPhotos.length === 0 ? (
          <Text style={[txt(500), { fontSize: 12, color: C.t4 }]}>
            {target === "truck"
              ? "Odometer, truck nameplate, anything worth a visual record."
              : "Trailer placard, load tag, any general trailer condition shots."}
          </Text>
        ) : (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {generalPhotos.map(ph => (
              <PhotoThumb key={ph.key} uri={ph.uri} onRemove={() => onRemovePhoto(ph.key)} />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function PhotoThumb({ uri, onRemove }: { uri: string; onRemove: () => void }) {
  const { C, SHADOW, ACCENT } = useTheme();
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
  const { C, SHADOW, ACCENT } = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      style={{
        paddingHorizontal: 14, paddingVertical: 9, borderRadius: 8,
        backgroundColor: active ? color : "transparent",
        borderWidth: 1, borderColor: active ? color : C.border,
        minWidth: 56, alignItems: "center",
      }}
    >
      <Text style={[txt(700), { fontSize: 13, color: active ? "white" : C.t3 }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PickerRow({ icon, label, value, onPress, disabled }: {
  icon: React.ReactNode; label: string; value: string; onPress: () => void; disabled?: boolean;
}) {
  const { C, SHADOW, ACCENT } = useTheme();
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
      <ChevronDown size={16} color={C.t4} />
    </TouchableOpacity>
  );
}

function PickerOverlay({ title, options, onPick, onClose }: {
  title: string;
  options: { id: number; label: string }[];
  onPick: (id: number) => void;
  onClose: () => void;
}) {
  // Search filter — case-insensitive substring match against the label
  // text (which already concatenates name + #unit / #trailerNumber).
  // Splitting the query on whitespace lets a driver type "ford 312" and
  // match a "2024 Ford F-150 · #312" row even though those tokens are
  // far apart in the label.
  const { C, SHADOW, ACCENT } = useTheme();
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
    <View style={{
      position: "absolute", inset: 0, backgroundColor: C.surface,
    }}>
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

      {/* Search row — only shown when there's enough rows to be worth
          filtering. <6 items just scroll naturally. */}
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
              style={{
                paddingHorizontal: 14, paddingVertical: 16,
                borderBottomWidth: 1, borderBottomColor: C.borderSoft,
              }}
            >
              <Text style={[txt(600), { fontSize: 16, color: C.t1 }]}>{opt.label}</Text>
            </TouchableOpacity>
          ))
        )}
      </ScrollView>
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

// Equipment label format per user spec: always prefix with the type
// word ("Truck …", "Trailer #…") so a screenful of pickers/labels
// makes the equipment type unambiguous. Trailer numbers are the
// natural identifier — name field is often a duplicate of the number,
// so we prefer the number when present.
function truckLabel(name: string, unit: string | null | undefined): string {
  return `Truck ${name}${unit ? ` #${unit}` : ""}`;
}

function trailerLabel(name: string, trailerNumber: string | null | undefined): string {
  if (trailerNumber) return `Trailer #${trailerNumber}`;
  return `Trailer ${name}`;
}

/** Short "Jul 7" style date for the recent-inspection caution. Falls back
 *  to the raw string if it doesn't parse. */
function fmtShortDate(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function groupBySection(items: ChecklistItem[]): { name: string; items: ChecklistItem[] }[] {
  const map = new Map<string, ChecklistItem[]>();
  for (const it of items) {
    const arr = map.get(it.section) ?? [];
    arr.push(it);
    map.set(it.section, arr);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items }));
}
