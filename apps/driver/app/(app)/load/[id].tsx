import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  Linking,
  TextInput,
  Dimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Truck,
  Container,
  DollarSign,
  Building2,
  Clock,
  Navigation,
  Info,
  AlertTriangle,
  Repeat2,
  HandCoins,
  Copy,
  Check,
  CheckCircle2,
  MapPin,
  CircleDot,
  Camera,
  FileText,
} from "lucide-react-native";
import * as Location from "expo-location";
import * as Clipboard from "expo-clipboard";
import { fetchLoad, updateLoadStatus, updateLoadTrailer, checkInStop, undoCheckInStop } from "@/lib/api/loads";
import { railway } from "@/lib/railway";
import { fetchDocuments } from "@/lib/api/documents";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { needsConfirmation } from "@/lib/loadStatus";
import { StatusBadge } from "@/components/StatusBadge";
import { StatusPickerSheet } from "@/components/StatusPickerSheet";
import { RelayHandoffPhotos, promptRelayHandoffUpload } from "@/components/RelayHandoffPhotos";
import { TrailerPickerSheet } from "@/components/TrailerPickerSheet";
import { RouteMap } from "@/components/RouteMap";
import { Toast } from "@/components/Toast";
import { DocumentsView } from "@/components/DocumentsView";
import { ExpandableInstructions } from "@/components/ExpandableInstructions";
import { useDriverSession } from "@/lib/useDriverSession";
import { ScheduleTypeChip } from "@/lib/loadCard";
import type { LoadStatus, Stop } from "@/lib/types";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const STATUS_TRANSITIONS: Partial<Record<LoadStatus, LoadStatus>> = {
  scheduled:  "dispatched",
  dispatched: "en_route",
  en_route:   "picked_up",
  picked_up:  "delivered",
};

const STATUS_CTA: Partial<Record<LoadStatus, string>> = {
  scheduled:  "Accept Load",
  dispatched: "Start Trip",
  en_route:   "Mark Picked Up",
  picked_up:  "Mark Delivered",
};

const STOP_TYPE_LABEL: Record<Stop["type"], string> = {
  pickup:    "Pickup",
  delivery:  "Delivery",
  drop_hook: "Drop & Hook",
  stop:      "Stop",
  relay:     "Relay",
};

const STOP_ACCENT: Record<Stop["type"], { bg: string; fg: string; iconBg: string }> = {
  pickup:    { bg: "#dcfce7", fg: "#15803d", iconBg: "#16a34a" }, // green
  delivery:  { bg: "#fee2e2", fg: "#b91c1c", iconBg: "#dc2626" }, // red
  drop_hook: { bg: "#dbeafe", fg: "#1e40af", iconBg: "#2563eb" },
  stop:      { bg: "#fef9c3", fg: "#854d0e", iconBg: "#eab308" }, // yellow
  relay:     { bg: "#f3e8fd", fg: "#6b21a8", iconBg: "#8b5cf6" },
};

/**
 * Notes block that supports partial-selection copy on iOS.
 * RN's <Text selectable> only allows copying the whole block; a non-editable
 * multiline TextInput uses UIKit's UITextView under the hood which gives the
 * native long-press selection handles for free.
 */
function SelectableText({ value, style }: { value: string; style: object }) {
  return (
    <TextInput
      value={value}
      editable={false}
      multiline
      scrollEnabled={false}
      style={[{ padding: 0, margin: 0, includeFontPadding: false } as object, style]}
    />
  );
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—";
  return iso.slice(11, 16);
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function MetaRow({
  Icon, label, value, color = "#202124",
}: {
  Icon: typeof Truck; label: string; value: string; color?: string;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}>
      <Icon size={15} color="#5f6368" strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color, maxWidth: "60%", textAlign: "right" }]}>
        {value}
      </Text>
    </View>
  );
}

function IdentifierRow({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={async () => {
        await Clipboard.setStringAsync(value);
        setCopied(true);
        onCopied?.();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: "#f1f3f4" }}
    >
      <Text style={[txt(600), { fontSize: 13, color: "#5f6368", flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: "#202124", marginRight: 10 }]} numberOfLines={1}>
        {value}
      </Text>
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: "#f1f3f4",
        alignItems: "center", justifyContent: "center",
      }}>
        {copied
          ? <Check size={13} color="#15803d" strokeWidth={2.6} />
          : <Copy  size={13} color="#5f6368" strokeWidth={2.2} />}
      </View>
    </TouchableOpacity>
  );
}

function RelayHandoffBanner({
  mode, partnerDriverName,
}: {
  mode: "pickup" | "delivery"; partnerDriverName?: string;
}) {
  return (
    <View
      style={{
        marginTop: 6,
        marginBottom: 12,
        padding: 14,
        borderRadius: 14,
        backgroundColor: "#fee2e2",
        borderWidth: 1.5,
        borderColor: "#dc2626",
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <HandCoins size={20} color="#b91c1c" strokeWidth={2.4} />
      <View style={{ flex: 1 }}>
        <Text style={[txt(800), { fontSize: 13, color: "#b91c1c", letterSpacing: 0.4 }]}>
          RELAY HANDOFF
        </Text>
        <Text style={[txt(700), { fontSize: 14, color: "#b91c1c", marginTop: 2 }]}>
          {mode === "pickup" ? "This is where you leave the load." : "You take over here."}
        </Text>
        {partnerDriverName ? (
          <Text style={[txt(500), { fontSize: 12, color: "#7f1d1d", marginTop: 2 }]}>
            {mode === "pickup"
              ? `${partnerDriverName} continues from here.`
              : `${partnerDriverName} brought it to this point.`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function fmtCheckInTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

// Distance between two lat/lng points in miles (haversine).
function distanceMiles(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 3958.8; // Earth radius in miles
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const VERIFY_THRESHOLD_MI = 0.5;

async function performCheckIn(
  stop: Stop,
  orgId: string,
  audit?: { eventId: string; changedByName: string },
): Promise<void> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") {
    throw new Error(
      "Location permission denied. Enable location for Curzon Driver in Settings.",
    );
  }
  const pos = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.Balanced,
  });
  const distMi =
    stop.lat != null && stop.lng != null
      ? distanceMiles(stop.lat, stop.lng, pos.coords.latitude, pos.coords.longitude)
      : undefined;
  await checkInStop(stop.id, orgId, pos.coords.latitude, pos.coords.longitude,
    audit ? {
      eventId:       audit.eventId,
      changedByName: audit.changedByName,
      stopFacility:  stop.facilityName ?? stop.city,
      stopType:      stop.type,
      distanceMi:    distMi,
    } : undefined,
  );
}

function CheckInButton({
  stop, orgId, onCheckedIn, eventId, driverName,
}: {
  stop: Stop; orgId?: string; onCheckedIn?: (action: "checkin") => void; eventId?: string; driverName?: string;
}) {
  const [busy, setBusy] = React.useState(false);

  async function handleCheckIn() {
    if (!orgId || busy) {
      if (!orgId) Alert.alert("Not ready", "Driver session not loaded yet.");
      return;
    }
    setBusy(true);
    try {
      await performCheckIn(stop, orgId,
        eventId && driverName ? { eventId, changedByName: driverName } : undefined,
      );
      onCheckedIn?.("checkin");
    } catch (err) {
      Alert.alert("Check-in failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <TouchableOpacity
      onPress={handleCheckIn}
      activeOpacity={0.85}
      disabled={busy}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 11,
        backgroundColor: "#f8f9fa",
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color="#15803d" />
      ) : (
        <>
          <MapPin size={13} color="#15803d" strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: "#15803d" }]}>Check In</Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function CheckedInChip({
  stop, orgId, onUpdated, eventId, driverName,
}: {
  stop: Stop; orgId?: string; onUpdated?: (action: "redo" | "undo") => void; eventId?: string; driverName?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const distMi =
    stop.lat != null && stop.lng != null && stop.arrivedLat != null && stop.arrivedLng != null
      ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat, stop.arrivedLng)
      : null;
  const verified = distMi != null && distMi <= VERIFY_THRESHOLD_MI;
  const palette = verified
    ? { bg: "#dcfce7", fg: "#15803d" }
    : { bg: "#fef9c3", fg: "#854d0e" };
  const distLabel =
    distMi == null ? null : distMi < 0.1 ? "on-site" : `${distMi.toFixed(1)} mi off`;

  function handleRetry() {
    if (!orgId || busy) return;
    Alert.alert(
      "Check-in options",
      "What would you like to do with this check-in?",
      [
        {
          text: "Undo check-in",
          style: "destructive",
          onPress: async () => {
            setBusy(true);
            try {
              await undoCheckInStop(stop.id, orgId,
                eventId && driverName
                  ? { eventId, changedByName: driverName, stopFacility: stop.facilityName ?? stop.city, stopType: stop.type }
                  : undefined,
              );
              onUpdated?.("undo");
            } catch (err) {
              Alert.alert("Undo failed", err instanceof Error ? err.message : "Unknown error");
            } finally {
              setBusy(false);
            }
          },
        },
        {
          text: "Redo check-in",
          onPress: async () => {
            setBusy(true);
            try {
              await performCheckIn(stop, orgId,
                eventId && driverName ? { eventId, changedByName: driverName } : undefined,
              );
              onUpdated?.("redo");
            } catch (err) {
              Alert.alert("Update failed", err instanceof Error ? err.message : "Unknown error");
            } finally {
              setBusy(false);
            }
          },
        },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={handleRetry}
      disabled={busy}
      style={{
        flex: 1,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 11,
        backgroundColor: palette.bg,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        <>
          {verified ? (
            <CheckCircle2 size={13} color={palette.fg} strokeWidth={2.4} />
          ) : (
            <AlertTriangle size={13} color={palette.fg} strokeWidth={2.4} />
          )}
          <Text style={[txt(700), { fontSize: 13, color: palette.fg }]}>
            {fmtCheckInTime(stop.arrivedAt!)}{distLabel ? ` · ${distLabel}` : ""}
          </Text>
        </>
      )}
    </TouchableOpacity>
  );
}

function CopyAddressButton({ value, onCopied }: { value: string; onCopied?: () => void }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  return (
    <TouchableOpacity
      activeOpacity={0.7}
      hitSlop={8}
      onPress={async () => {
        await Clipboard.setStringAsync(value);
        setCopied(true);
        onCopied?.();
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        width: 30, height: 30, borderRadius: 10,
        backgroundColor: "#f1f3f4",
        alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: "#e8eaed",
      }}
    >
      {copied ? (
        <Check size={14} color="#15803d" strokeWidth={2.6} />
      ) : (
        <Copy size={14} color="#5f6368" strokeWidth={2.2} />
      )}
    </TouchableOpacity>
  );
}

function TimeAnchor({
  kind, iso,
}: { kind: "start" | "end"; iso?: string }) {
  const label = kind === "start" ? "START TIME" : "END TIME";
  const tint  = { bg: "#e8f0fe", fg: "#1558d6", iconBg: "#1a73e8" };
  let display = "—";
  if (iso) {
    const d = new Date(iso.replace(" ", "T"));
    if (!isNaN(d.getTime())) {
      display = d.toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    }
  }
  return (
    <View
      style={{
        backgroundColor: "#ffffff",
        borderRadius:    14,
        marginBottom:    10,
        padding:         14,
        borderWidth:     1,
        borderColor:     "#e8eaed",
        flexDirection:   "row",
        alignItems:      "center",
        gap:             12,
      }}
    >
      <View
        style={{
          width: 40, height: 40, borderRadius: 12,
          backgroundColor: tint.iconBg,
          alignItems: "center", justifyContent: "center",
        }}
      >
        <Clock size={18} color="#ffffff" strokeWidth={2.4} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint.bg, marginBottom: 4 }}>
          <Text style={[txt(800), { fontSize: 10, color: tint.fg, letterSpacing: 0.5 }]}>
            {label}
          </Text>
        </View>
        <Text style={[txt(800), { fontSize: 15, color: "#202124" }]} numberOfLines={1}>
          {display}
        </Text>
      </View>
    </View>
  );
}

function StopCard({
  stop, index, onAddressCopied, orgId, onCheckedIn, eventId, driverName,
  loadId, onPhotoUploaded, relayRole, onViewDocuments,
}: {
  stop: Stop;
  index: number;
  onAddressCopied?: () => void;
  orgId?: string;
  onCheckedIn?: (action?: "checkin" | "redo" | "undo") => void;
  eventId?: string;
  driverName?: string;
  // For relay stops, when these are provided the card renders a
  // "Upload Pictures" / "View Handoff Photos" button under
  // Navigate / Check In. The identifier is actually the EVENT id —
  // the driver API path is /v1/driver/loads/:id/documents but
  // treats :id as event id.
  loadId?: string;
  onPhotoUploaded?: () => void;
  // Pickup driver leaves handoff photos for the delivery driver, so
  // the button flips based on which leg this is:
  //   pickup    → "Upload Pictures" (file picker)
  //   delivery  → "View Handoff Photos" (jumps to Documents tab)
  relayRole?: "pickup" | "delivery";
  onViewDocuments?: () => void;
}) {
  const accent = STOP_ACCENT[stop.type];
  const facility = stop.facilityName ?? stop.city ?? stop.address ?? "—";
  const copyValue = stop.address ?? stop.city ?? stop.facilityName ?? "";
  const window =
    stop.apptStart && stop.apptEnd && stop.apptStart !== stop.apptEnd
      ? `${fmtTime(stop.apptStart)} – ${fmtTime(stop.apptEnd)}`
      : fmtTime(stop.apptStart);

  function openMaps() {
    const target =
      stop.lat && stop.lng
        ? `${stop.lat},${stop.lng}`
        : encodeURIComponent(stop.address ?? `${stop.facilityName ?? ""} ${stop.city ?? ""}`.trim());
    Alert.alert(
      "Open in",
      undefined,
      [
        { text: "Apple Maps",  onPress: () => Linking.openURL(`http://maps.apple.com/?daddr=${target}`) },
        { text: "Google Maps", onPress: () => Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${target}`) },
        { text: "Cancel", style: "cancel" },
      ],
    );
  }

  return (
    <View
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 14,
        marginBottom: 10,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: "#e8eaed",
      }}
    >
      {copyValue ? (
        <View style={{ position: "absolute", top: 10, right: 10, zIndex: 2 }}>
          <CopyAddressButton value={copyValue} onCopied={onAddressCopied} />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", padding: 14 }}>
        {/* Number pill */}
        <View
          style={{
            width: 40, height: 40, borderRadius: 12,
            backgroundColor: accent.iconBg,
            alignItems: "center", justifyContent: "center",
            marginRight: 12,
          }}
        >
          <Text style={[txt(800), { color: "#ffffff", fontSize: 16 }]}>{index + 1}</Text>
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: accent.bg }}>
              <Text style={[txt(800), { fontSize: 10, color: accent.fg, letterSpacing: 0.5 }]}>
                {STOP_TYPE_LABEL[stop.type].toUpperCase()}
              </Text>
            </View>
          </View>

          <Text style={[txt(800), { fontSize: 16, color: "#202124" }]} numberOfLines={2}>
            {facility}
          </Text>
          {stop.address && stop.address !== facility ? (
            <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]} numberOfLines={2}>
              {stop.address}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Clock size={12} color="#5f6368" strokeWidth={2.2} />
              <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]}>
                {fmtDate(stop.apptStart)} · {window}
              </Text>
            </View>
            <ScheduleTypeChip stop={stop} size="small" />
          </View>
        </View>
      </View>

      {/* Navigate + Check In row */}
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: "#f1f3f4" }}>
        <TouchableOpacity
          onPress={openMaps}
          activeOpacity={0.85}
          style={{
            flex: 1,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            paddingVertical: 11,
            backgroundColor: "#f8f9fa",
          }}
        >
          <Navigation size={13} color="#1a73e8" strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: "#1a73e8" }]}>Navigate</Text>
        </TouchableOpacity>

        <View style={{ width: 1, backgroundColor: "#f1f3f4" }} />

        {stop.arrivedAt
          ? <CheckedInChip stop={stop} orgId={orgId} onUpdated={onCheckedIn} eventId={eventId} driverName={driverName} />
          : <CheckInButton stop={stop} orgId={orgId} onCheckedIn={onCheckedIn} eventId={eventId} driverName={driverName} />}
      </View>

      {/* Relay handoff: pickup leg uploads photos for the partner;
          delivery leg jumps to the documents viewer to see what the
          partner left behind (trailer location, paperwork, etc.). */}
      {stop.type === "relay" && loadId ? (
        relayRole === "delivery" && onViewDocuments ? (
          <TouchableOpacity
            onPress={onViewDocuments}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: 8,
              paddingVertical: 12,
              backgroundColor: "#faf5ff",
              borderTopWidth: 1, borderTopColor: "#f1f3f4",
            }}
          >
            <FileText size={14} color="#6b21a8" strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: "#6b21a8", letterSpacing: 0.2 }]}>
              View Handoff Photos
            </Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={() => promptRelayHandoffUpload(loadId, onPhotoUploaded)}
            activeOpacity={0.85}
            style={{
              flexDirection: "row", alignItems: "center", justifyContent: "center",
              gap: 8,
              paddingVertical: 12,
              backgroundColor: "#faf5ff",
              borderTopWidth: 1, borderTopColor: "#f1f3f4",
            }}
          >
            <Camera size={14} color="#6b21a8" strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: "#6b21a8", letterSpacing: 0.2 }]}>
              Upload Pictures
            </Text>
          </TouchableOpacity>
        )
      ) : null}

      {stop.instructions ? (
        <View style={{ paddingHorizontal: 14, paddingVertical: 12, backgroundColor: "#fff7ed", borderTopWidth: 1, borderTopColor: "#f1f3f4" }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <Info size={13} color="#9a3412" strokeWidth={2.2} style={{ marginTop: 2 }} />
            <ExpandableInstructions
              value={stop.instructions}
              textStyle={{ ...txt(600), fontSize: 13, color: "#9a3412", lineHeight: 18 }}
              toggleColor="#9a3412"
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default function LoadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const [uploadVisible,         setUploadVisible]        = useState(false);
  const [statusPickerVisible,   setStatusPickerVisible]  = useState(false);
  const [trailerPickerVisible,  setTrailerPickerVisible] = useState(false);
  // True while the trailer picker is open because the user just tapped
  // Start Trip — picking a trailer (or "Continue without trailer")
  // then fires the en_route status transition.
  const [startTripPending,      setStartTripPending]     = useState(false);
  const [toastMessage,          setToastMessage]         = useState<string | null>(null);
  const [tab,                   setTab]                  = useState<0 | 1 | 2>(0);
  // Bumped whenever a relay handoff photo is uploaded from anywhere on
  // this screen — passed to the gallery so it re-fetches.
  const [relayPhotosReloadKey,  setRelayPhotosReloadKey] = useState(0);
  const pagerRef = React.useRef<ScrollView>(null);
  const SCREEN_W = Dimensions.get("window").width;
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = React.useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMessage(null), 1800);
  }, []);

  const { data: load, isLoading } = useQuery({
    queryKey: ["load", id],
    queryFn:  () => fetchLoad(id!, driver!.driverId, driver!.orgId),
    enabled:  !!id && !!driver,
  });

  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", driver?.orgId],
    queryFn:  () => fetchOrgSettings(driver!.orgId),
    enabled:  !!driver,
    staleTime: 5 * 60 * 1000,
  });

  // Live truck location for the asset bound to this load. 404s silently
  // when the asset has no Motive vehicle id or the org has no Motive
  // API key — RouteMap renders without the truck pin in that case.
  const { data: truckLoc } = useQuery({
    queryKey: ["truck-location", id],
    queryFn:  async () => {
      try { return await railway.getTruckLocation(id!); }
      catch (err) {
        const status = (err as { status?: number } | undefined)?.status;
        if (status === 404 || status === 403) return null;
        throw err;
      }
    },
    enabled:  !!id && !!driver,
    refetchInterval: 60 * 1000, // poll once a minute while open
    staleTime: 30 * 1000,
  });

  const { mutate: changeStatus, isPending } = useMutation({
    mutationFn: (newStatus: LoadStatus) =>
      updateLoadStatus(id!, driver!.orgId, newStatus, load?.status, driver?.name),
    onSuccess: (_data, newStatus) => {
      queryClient.invalidateQueries({ queryKey: ["loads"] });
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      // Brief toast instead of a modal — the badge in the header
      // already shows the new state, the toast is just a confirmation
      // pulse so the user knows the tap landed.
      const label = newStatus.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase());
      showToast(`Marked as ${label}`);
    },
    onError: (err: Error) => Alert.alert("Update failed", err.message),
  });

  const { mutate: changeTrailer } = useMutation({
    mutationFn: (newTrailerId: number | null) =>
      updateLoadTrailer(id!, driver!.orgId, newTrailerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["loads"] });
      queryClient.invalidateQueries({ queryKey: ["load", id] });
    },
    onError: (err: Error) => Alert.alert("Update failed", err.message),
  });

  if (isLoading || !load) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: "#f8f9fa", alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color="#1a73e8" />
      </SafeAreaView>
    );
  }

  const needsAction = needsConfirmation(load);
  // For scheduled loads, only show Accept Load CTA inside the 12h confirmation window.
  const ctaActive   = load.status !== "scheduled" || needsAction;
  const nextStatus  = ctaActive ? STATUS_TRANSITIONS[load.status] : undefined;
  const ctaLabel    = ctaActive ? STATUS_CTA[load.status]         : undefined;

  // First geocoded pickup stop — used to auto-fire picked_up on its check-in.
  const firstPickupStopId = load.stops.find((s) => s.type === "pickup")?.id;

  // After a stop check-in, if the load is en_route and the checked-in stop is the
  // first pickup, advance status to picked_up automatically.
  function handleAfterCheckIn(stopId: string) {
    if (load && load.status === "en_route" && stopId === firstPickupStopId) {
      changeStatus("picked_up");
    }
  }

  function selectTab(idx: 0 | 1 | 2) {
    setTab(idx);
    pagerRef.current?.scrollTo({ x: idx * SCREEN_W, animated: true });
  }

  async function handleMarkDelivered() {
    if (!load || !driver) return;
    // Paperwork safety check stays — this isn't a "are you sure?"
    // confirm, it's a productive prompt to get POD/BOL onto the load
    // before it closes out. Skips straight through when docs exist.
    const docs = await fetchDocuments(load.id, driver.orgId);
    if (docs.length === 0) {
      Alert.alert(
        "Upload paperwork?",
        "No documents uploaded for this load yet. Upload BOL/POD before marking delivered?",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Skip",
            style: "destructive",
            onPress: () => changeStatus("delivered"),
          },
          {
            text: "Upload",
            onPress: () => {
              selectTab(2);
              setUploadVisible(true);
            },
          },
        ],
      );
      return;
    }
    changeStatus("delivered");
  }

  function handleStatusUpdate() {
    if (!nextStatus || !load) return;
    if (nextStatus === "delivered") {
      handleMarkDelivered();
      return;
    }
    if (nextStatus === "en_route") {
      // Starting a trip — prompt for the trailer first so we capture
      // what the driver is actually pulling. The picker's onSelect /
      // onSkip handlers fire the status transition afterwards.
      setStartTripPending(true);
      setTrailerPickerVisible(true);
      return;
    }
    // One-tap for every other transition (dispatched, picked_up).
    // The toast on success and the status badge in the header give
    // enough feedback — no confirm dialogs.
    changeStatus(nextStatus);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: "#1a73e8" }} edges={["top"]}>
      {/* Nav bar */}
      <View
        style={{
          backgroundColor: "#1a73e8",
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 14,
          gap: 12,
        }}
      >
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          activeOpacity={0.7}
          style={{
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: "rgba(255,255,255,0.1)",
            alignItems: "center", justifyContent: "center",
          }}
        >
          <ArrowLeft size={18} color="#ffffff" strokeWidth={2.2} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[txt(800), { fontSize: 16, color: "#ffffff" }]} numberOfLines={1}>
            {load.title}
          </Text>
          {load.eventKind === "non_revenue" ? (
            <View style={{
              alignSelf: "flex-start",
              flexDirection: "row", alignItems: "center", gap: 5,
              paddingHorizontal: 7, paddingVertical: 2,
              marginTop: 4,
              borderRadius: 999,
              backgroundColor: "rgba(255,255,255,0.18)",
            }}>
              <Text style={[txt(800), { fontSize: 9, color: "#ffffff", letterSpacing: 0.4 }]}>
                NON-REVENUE
              </Text>
              {load.nonRevenueType ? (
                <>
                  <Text style={[txt(700), { fontSize: 9, color: "rgba(255,255,255,0.7)" }]}>·</Text>
                  <Text style={[txt(800), { fontSize: 9, color: "#ffffff", letterSpacing: 0.3 }]} numberOfLines={1}>
                    {load.nonRevenueType.toUpperCase()}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => setStatusPickerVisible(true)}
          activeOpacity={0.7}
          style={{
            width: 36, height: 36, borderRadius: 18,
            backgroundColor: "rgba(255,255,255,0.1)",
            alignItems: "center", justifyContent: "center",
          }}
        >
          <CircleDot size={18} color="#ffffff" strokeWidth={2.2} />
        </TouchableOpacity>
      </View>

      {/* Tab bar */}
      <View style={{ flexDirection: "row", backgroundColor: "#1a73e8", paddingHorizontal: 22 }}>
        {(["Stops", "Details", "Documents"] as const).map((label, i) => {
          const isActive = tab === i;
          return (
            <TouchableOpacity
              key={label}
              onPress={() => selectTab(i as 0 | 1 | 2)}
              activeOpacity={0.7}
              style={{ flex: 1, alignItems: "center", paddingBottom: 10 }}
            >
              <Text style={[
                txt(isActive ? 800 : 600),
                { fontSize: 13, color: isActive ? "#ffffff" : "rgba(255,255,255,0.55)", marginBottom: 8 },
              ]}>
                {label}
              </Text>
              <View style={{
                height: 3, width: "60%", borderRadius: 2,
                backgroundColor: isActive ? "#ffffff" : "transparent",
              }} />
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView
        ref={pagerRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => {
          const idx = Math.round(e.nativeEvent.contentOffset.x / SCREEN_W) as 0 | 1 | 2;
          setTab(idx);
        }}
        style={{ flex: 1 }}
      >
      {/* Stops tab — route map + timeline */}
      <ScrollView style={{ width: SCREEN_W, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }} nestedScrollEnabled>
        {/* Route map */}
        <View style={{ marginBottom: 14 }}>
          <RouteMap
            stops={load.stops}
            truckLat={truckLoc?.lat}
            truckLng={truckLoc?.lon}
            assetColor={truckLoc?.color}
          />
        </View>

        {/* Start time → stops → End time, joined by a vertical timeline rail. */}
        <View style={{ position: "relative" }}>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 33, top: 30, bottom: 30, width: 2,
              backgroundColor: "#c8d4ee",
              borderRadius: 1,
            }}
          />

        {/* Start time */}
        <TimeAnchor kind="start" iso={load.start} />

        {load.stops.length === 0 ? (
          <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", marginBottom: 14 }]}>
            No stops on this load yet.
          </Text>
        ) : (() => {
          const relayIdx = load.relayGroupId
            ? load.stops.findIndex((s) => s.type === "relay")
            : -1;

          if (relayIdx === -1) {
            return load.stops.map((s, i) => <StopCard key={s.id} stop={s} index={i} onAddressCopied={() => showToast("Address copied")}
                orgId={driver?.orgId}
                onCheckedIn={(action) => {
                  queryClient.invalidateQueries({ queryKey: ["load", id] });
                  showToast(action === "undo" ? "Check In Undone" : "Checked in");
                  if (action !== "undo") handleAfterCheckIn(s.id);
                }}
                eventId={load.id}
                driverName={driver?.name}
                loadId={load.id}
                onPhotoUploaded={() => { showToast("Photo uploaded"); setRelayPhotosReloadKey(k => k + 1); }} />);
          }

          const isPickupLeg = load.relayRole !== "delivery";

          if (isPickupLeg) {
            const mine = load.stops.slice(0, relayIdx + 1);
            const partner = load.stops.slice(relayIdx + 1);
            return (
              <>
                {mine.map((s, i) => <StopCard key={s.id} stop={s} index={i} onAddressCopied={() => showToast("Address copied")}
                orgId={driver?.orgId}
                onCheckedIn={(action) => {
                  queryClient.invalidateQueries({ queryKey: ["load", id] });
                  showToast(action === "undo" ? "Check In Undone" : "Checked in");
                  if (action !== "undo") handleAfterCheckIn(s.id);
                }}
                eventId={load.id}
                driverName={driver?.name}
                loadId={load.id}
                relayRole="pickup"
                onPhotoUploaded={() => { showToast("Photo uploaded"); setRelayPhotosReloadKey(k => k + 1); }} />)}
                <RelayHandoffBanner mode="pickup" partnerDriverName={load.partnerDriverName} />
                {partner.length > 0 ? (
                  <>
                    <Text
                      style={[
                        txt(800),
                        { fontSize: 11, letterSpacing: 1.1, color: "#9aa0a6", marginBottom: 10, textTransform: "uppercase" },
                      ]}
                    >
                      Continued by partner
                    </Text>
                    {/* relative wrapper + opaque rail mask. The faded card
                        wrapper below is 35% opacity, so the timeline rail
                        bleeds through both the gap between cards and the
                        cards themselves. This mask sits between the rail
                        and the dimmed content at the rail's x-column. */}
                    <View style={{ position: "relative" }}>
                      <View
                        pointerEvents="none"
                        style={{ position: "absolute", left: 28, width: 12, top: 0, bottom: 0, backgroundColor: "#f8f9fa" }}
                      />
                      <View style={{ opacity: 0.35 }} pointerEvents="none">
                        {partner.map((s, i) => (
                          <StopCard key={s.id} stop={s} index={mine.length + i} />
                        ))}
                      </View>
                    </View>
                  </>
                ) : null}
              </>
            );
          }

          const partner = load.stops.slice(0, relayIdx);
          const mine    = load.stops.slice(relayIdx);
          return (
            <>
              {partner.length > 0 ? (
                <>
                  <Text
                    style={[
                      txt(800),
                      { fontSize: 11, letterSpacing: 1.1, color: "#9aa0a6", marginBottom: 10, textTransform: "uppercase" },
                    ]}
                  >
                    Completed by partner
                  </Text>
                  {/* Mask the timeline rail behind the dimmed partner
                      section — see matching block in the pickup-leg path. */}
                  <View style={{ position: "relative" }}>
                    <View
                      pointerEvents="none"
                      style={{ position: "absolute", left: 28, width: 12, top: 0, bottom: 0, backgroundColor: "#f8f9fa" }}
                    />
                    <View style={{ opacity: 0.35 }} pointerEvents="none">
                      {partner.map((s, i) => (
                        <StopCard key={s.id} stop={s} index={i} onAddressCopied={() => showToast("Address copied")}
                orgId={driver?.orgId}
                onCheckedIn={(action) => {
                  queryClient.invalidateQueries({ queryKey: ["load", id] });
                  showToast(action === "undo" ? "Check In Undone" : "Checked in");
                  if (action !== "undo") handleAfterCheckIn(s.id);
                }}
                eventId={load.id}
                driverName={driver?.name}
                loadId={load.id}
                onPhotoUploaded={() => { showToast("Photo uploaded"); setRelayPhotosReloadKey(k => k + 1); }} />
                      ))}
                    </View>
                  </View>
                </>
              ) : null}
              <RelayHandoffBanner mode="delivery" partnerDriverName={load.partnerDriverName} />
              {mine.map((s, i) => (
                <StopCard
                  key={s.id}
                  stop={s}
                  index={partner.length + i}
                  onAddressCopied={() => showToast("Address copied")}
                  orgId={driver?.orgId}
                  onCheckedIn={(action) => {
                    queryClient.invalidateQueries({ queryKey: ["load", id] });
                    showToast(action === "undo" ? "Check In Undone" : "Checked in");
                    if (action !== "undo") handleAfterCheckIn(s.id);
                  }}
                  eventId={load.id}
                  driverName={driver?.name}
                  loadId={load.id}
                  relayRole="delivery"
                  onViewDocuments={() => selectTab(2)}
                  onPhotoUploaded={() => { showToast("Photo uploaded"); setRelayPhotosReloadKey(k => k + 1); }}
                />
              ))}
            </>
          );
        })()}

        {/* End time */}
        <TimeAnchor kind="end" iso={load.end} />
        </View>
      </ScrollView>

      {/* Details tab */}
      <ScrollView style={{ width: SCREEN_W, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }} nestedScrollEnabled>
        {/* Relay disclaimer + handoff photos. Photos are shared
            across both legs (`kind='relay_handoff'` on load_documents).
            Pickup driver leaves "where I parked the trailer" / paperwork
            shots; delivery driver picks them up. */}
        {load.relayGroupId && load.loadId ? (
          <View
            style={{
              backgroundColor: "#f3e8fd",
              borderRadius: 14,
              padding: 14,
              borderWidth: 1, borderColor: "#ddd6fe",
              marginBottom: 14,
            }}
          >
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Repeat2 size={20} color="#6b21a8" strokeWidth={2.2} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 13, color: "#6b21a8", letterSpacing: 0.2 }]}>
                  Relay Load — {load.relayRole === "pickup" ? "First Leg" : "Second Leg"}
                </Text>
                <Text style={[txt(500), { fontSize: 13, color: "#6b21a8", lineHeight: 19, marginTop: 4, opacity: 0.95 }]}>
                  {load.relayRole === "pickup"
                    ? `You haul this load to the relay handoff point, then ${load.partnerDriverName ?? "another driver"} takes it the rest of the way.`
                    : `${load.partnerDriverName ?? "Another driver"} starts this load. You pick it up at the relay point and finish the delivery.`}
                </Text>
              </View>
            </View>
            <RelayHandoffPhotos loadId={load.id} reloadKey={relayPhotosReloadKey} />
          </View>
        ) : null}

        {/* References */}
        {(load.internalLoadId || load.loadNum || (load.refNums && load.refNums.length > 0)) && (
          <View
            style={{
              backgroundColor: "#ffffff",
              borderRadius: 14,
              paddingHorizontal: 14,
              borderWidth: 1, borderColor: "#e8eaed",
              marginBottom: 16,
            }}
          >
            {load.internalLoadId ? (
              <IdentifierRow label="Internal ID" value={String(load.internalLoadId)} onCopied={() => showToast("Copied")} />
            ) : null}
            {load.loadNum ? (
              <IdentifierRow label="Load #" value={load.loadNum} onCopied={() => showToast("Copied")} />
            ) : null}
            {(load.refNums ?? []).map((r, i) => (
              <IdentifierRow
                key={`${r.label}-${i}`}
                label={r.label || "Reference"}
                value={r.value}
                onCopied={() => showToast("Copied")}
              />
            ))}
          </View>
        )}

        {/* Summary card */}
        <View
          style={{
            backgroundColor: "#ffffff",
            borderRadius: 14,
            padding: 14,
            borderWidth: 1, borderColor: "#e8eaed",
            marginBottom: 18,
          }}
        >
          {load.broker      ? <MetaRow Icon={Building2} label="Broker"  value={load.broker}      /> : null}
          {load.assetName   ? <MetaRow Icon={Truck}     label="Truck"   value={load.assetName}   /> : null}
          {load.trailerType ? <MetaRow Icon={Container} label="Trailer Type" value={load.trailerType} /> : null}
          <TouchableOpacity onPress={() => setTrailerPickerVisible(true)} activeOpacity={0.6}>
            <MetaRow
              Icon={Container}
              label="Trailer"
              value={load.trailerName ?? "Tap to select"}
              color={load.trailerName ? "#202124" : "#1a73e8"}
            />
          </TouchableOpacity>
          {load.driverPay != null && orgSettings?.showDriverPay ? (
            <MetaRow
              Icon={DollarSign}
              label="Pay"
              value={`$${load.driverPay.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
              color="#15803d"
            />
          ) : null}
        </View>


        {/* Special Instructions — load.notes is canonical, specialInstructions is legacy fallback */}
        {(load.notes || load.specialInstructions) ? (
          <>
            <Text
              style={[
                txt(800),
                { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", marginTop: 16, marginBottom: 10, textTransform: "uppercase" },
              ]}
            >
              Special Instructions
            </Text>
            <View
              style={{
                backgroundColor: "#fef3c7",
                borderRadius: 12,
                padding: 12,
                flexDirection: "row",
                gap: 10,
                borderWidth: 1,
                borderColor: "#fde68a",
              }}
            >
              <AlertTriangle size={15} color="#92400e" strokeWidth={2.2} style={{ marginTop: 2 }} />
              <SelectableText
                value={load.notes ?? load.specialInstructions ?? ""}
                style={{ ...txt(600), fontSize: 13, color: "#92400e", flex: 1, lineHeight: 18 }}
              />
            </View>
          </>
        ) : null}
      </ScrollView>

      {/* Documents tab */}
      {driver ? (
        <DocumentsView
          eventId={load.id}
          orgId={driver.orgId}
          driverId={driver.driverId}
          driverName={driver.name}
          loadNum={load.loadNum}
          uploadVisible={uploadVisible}
          setUploadVisible={setUploadVisible}
          width={SCREEN_W}
        />
      ) : (
        <View style={{ width: SCREEN_W }} />
      )}
      </ScrollView>

      {/* Sticky CTA */}
      {ctaLabel && nextStatus && (
        <View
          style={{
            position: "absolute",
            left: 16, right: 16, bottom: 18,
          }}
        >
          <TouchableOpacity
            onPress={handleStatusUpdate}
            activeOpacity={0.88}
            disabled={isPending}
            style={{
              backgroundColor: "#1a73e8",
              borderRadius: 16,
              paddingVertical: 18,
              alignItems: "center",
              shadowColor: "#1a73e8",
              shadowOpacity: 0.4,
              shadowRadius: 18,
              shadowOffset: { width: 0, height: 8 },
            }}
          >
            {isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: 0.3 }]}>
                {ctaLabel}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      )}

      <StatusPickerSheet
        visible={statusPickerVisible}
        current={load.status}
        onClose={() => setStatusPickerVisible(false)}
        onSelect={(s) => {
          setStatusPickerVisible(false);
          if (s !== load.status) changeStatus(s);
        }}
      />

      {driver ? (
        <TrailerPickerSheet
          visible={trailerPickerVisible}
          orgId={driver.orgId}
          currentId={load.trailerId}
          title={startTripPending ? "What trailer are you pulling?" : undefined}
          onClose={() => {
            setTrailerPickerVisible(false);
            // Dismissing without picking = cancel Start Trip. Driver
            // can tap Start Trip again whenever they're ready.
            setStartTripPending(false);
          }}
          onSelect={(trailerId) => {
            setTrailerPickerVisible(false);
            if (trailerId !== load.trailerId) changeTrailer(trailerId);
            if (startTripPending) {
              changeStatus("en_route");
              setStartTripPending(false);
            }
          }}
          onSkip={startTripPending ? () => {
            setTrailerPickerVisible(false);
            changeStatus("en_route");
            setStartTripPending(false);
          } : undefined}
        />
      ) : null}

      <Toast message={toastMessage} />
    </SafeAreaView>
  );
}
