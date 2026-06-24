import React, { useState, useEffect, useCallback } from "react";
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
  InteractionManager,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
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
import { fetchLoad, updateLoadStatus, updateLoadTrailer, checkInStop, undoCheckInStop, confirmLoad } from "@/lib/api/loads";
import { railway } from "@/lib/railway";
import { fetchDocuments } from "@/lib/api/documents";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
// needsConfirmation was the legacy 12h-out gate for the "Accept Load"
// CTA. No longer used — Start Trip is always shown and Confirm replaces
// the Accept step. The helper itself still lives in lib/loadStatus for
// any other callers (e.g., schedule view's "needs action" badge).
import { StatusBadge } from "@/components/StatusBadge";
import { StatusPickerSheet } from "@/components/StatusPickerSheet";
import { RelayHandoffPhotos, promptRelayHandoffUpload } from "@/components/RelayHandoffPhotos";
// Trailer pin feature hidden 2026-05-22 — component preserved for re-enable.
// import { RelayTrailerLocation } from "@/components/RelayTrailerLocation";
import { TrailerPickerSheet } from "@/components/TrailerPickerSheet";
import { RouteMap, type RouteMapHandle } from "@/components/RouteMap";
import { AssignedTruckCard } from "@/components/AssignedTruckCard";
import { Toast } from "@/components/Toast";
import { DocumentsView } from "@/components/DocumentsView";
import { ExpandableInstructions } from "@/components/ExpandableInstructions";
import { useDriverSession } from "@/lib/useDriverSession";
import { ScheduleTypeChip } from "@/lib/loadCard";
import { needsRunConfirmation } from "@/lib/loadStatus";
import type { LoadStatus, Stop } from "@/lib/types";
import { isModuleEnabled } from "@fleetcal/types";
import { Glass } from "@/components/Glass";
import { SP, RADIUS } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

// "Accept Load" is gone — confirming the load IS accepting it. The
// three pre-trip states (scheduled, assigned, dispatched) all jump
// directly to en_route on Start Trip. `assigned` is in fact the MOST
// common state a driver opens a load in — a driver only ever sees
// loads assigned to them, so dispatch's assignment moves it from
// scheduled → assigned before the driver ever taps in. Omitting it
// here is what made the Start Trip dock vanish on freshly-assigned
// loads. The server stamps confirmed_at automatically when status
// advances past 'scheduled' so the skip-confirm-and-go-straight-to-
// Start-Trip path still records the acknowledgment.
const STATUS_TRANSITIONS: Partial<Record<LoadStatus, LoadStatus>> = {
  scheduled:  "en_route",
  assigned:   "en_route",
  dispatched: "en_route",
  en_route:   "picked_up",
  picked_up:  "delivered",
};

const STATUS_CTA: Partial<Record<LoadStatus, string>> = {
  scheduled:  "Start Trip",
  assigned:   "Start Trip",
  dispatched: "Start Trip",
  en_route:   "Mark Picked Up",
  picked_up:  "Mark Delivered",
};

// IMPORTANT: every StopType in packages/types/enums.ts (STOP_TYPES)
// needs a row in BOTH records below. A missing key would resolve to
// undefined at runtime — StopCard then tries to read `.iconBg` /
// `.bg` / `.fg` off undefined and the whole load detail screen
// throws a TypeError. expo-updates' uncaught-exception handler
// catches it and SIGABRTs the process via ErrorRecovery — i.e.
// the whole app crashes on a single bad load.
//
// The TypeScript compiler enforces this completeness via the
// Record<Stop["type"], ...> generic. If you add a new StopType,
// this file will fail to typecheck until you add the row here.
// (We previously had to remediate `drop` missing — see commit
// history.)
const STOP_TYPE_LABEL: Record<Stop["type"], string> = {
  pickup:    "Pickup",
  delivery:  "Delivery",
  drop:      "Drop",
  drop_hook: "Drop & Hook",
  stop:      "Stop",
  relay:     "Relay",
};

// Stop-type colors come from the theme (STOP_TINT bg/fg + STOP_SOLID icon
// tile) so they flip with light/dark mode — resolved in StopCardInner.

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
  Icon, label, value, color,
}: {
  Icon: typeof Truck; label: string; value: string; color?: string;
}) {
  const { C } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}>
      <Icon size={15} color={C.t3} strokeWidth={2} />
      <Text style={[txt(600), { fontSize: 13, color: C.t3, marginLeft: 10, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: color ?? C.t1, maxWidth: "60%", textAlign: "right" }]}>
        {value}
      </Text>
    </View>
  );
}

function IdentifierRow({ label, value, onCopied }: { label: string; value: string; onCopied?: () => void }) {
  const { C } = useTheme();
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
      style={{ flexDirection: "row", alignItems: "center", paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: C.borderSoft }}
    >
      <Text style={[txt(600), { fontSize: 13, color: C.t3, flex: 1 }]}>
        {label}
      </Text>
      <Text style={[txt(700), { fontSize: 14, color: C.t1, marginRight: 10 }]} numberOfLines={1}>
        {value}
      </Text>
      <View style={{
        width: 28, height: 28, borderRadius: 8,
        backgroundColor: C.borderSoft,
        alignItems: "center", justifyContent: "center",
      }}>
        {copied
          ? <Check size={13} color={C.greenInk} strokeWidth={2.6} />
          : <Copy  size={13} color={C.t3} strokeWidth={2.2} />}
      </View>
    </TouchableOpacity>
  );
}

function RelayHandoffBanner({
  mode, partnerDriverName,
}: {
  mode: "pickup" | "delivery"; partnerDriverName?: string;
}) {
  const { C } = useTheme();
  return (
    <View
      style={{
        marginTop: 6,
        marginBottom: 12,
        padding: 14,
        borderRadius: 18,
        backgroundColor: C.redBg,
        borderWidth: 1.5,
        borderColor: C.red,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <HandCoins size={20} color={C.redInk} strokeWidth={2.4} />
      <View style={{ flex: 1 }}>
        <Text style={[txt(800), { fontSize: 13, color: C.redInk, letterSpacing: 0.4 }]}>
          RELAY HANDOFF
        </Text>
        <Text style={[txt(700), { fontSize: 14, color: C.redInk, marginTop: 2 }]}>
          {mode === "pickup" ? "This is where you leave the load." : "You take over here."}
        </Text>
        {partnerDriverName ? (
          <Text style={[txt(500), { fontSize: 12, color: C.redInk, marginTop: 2 }]}>
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

/**
 * Check the driver in at a stop. Tries to capture lat/lng so the
 * server can verify proximity, but falls back to a coords-less
 * check-in if the device denies location — that way the driver
 * never gets blocked mid-trip by a permission they declined at
 * install time. The server treats coord-less check-ins as
 * "unverified" (audit trail still records the attempt).
 */
async function performCheckIn(
  stop: Stop,
  orgId: string,
  audit?: { eventId: string; changedByName: string },
): Promise<{ usedLocation: boolean }> {
  let coords: { lat: number; lng: number } | null = null;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === "granted") {
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    }
  } catch (err) {
    // GPS unavailable (denied, no signal, hardware off) — fall
    // through to coordless check-in rather than blocking the
    // driver. The check-in itself is the load-progression event;
    // location is verification metadata, not a hard requirement.
    console.warn("[checkIn] location failed:", err);
  }

  const distMi =
    coords && stop.lat != null && stop.lng != null
      ? distanceMiles(stop.lat, stop.lng, coords.lat, coords.lng)
      : undefined;

  await checkInStop(
    stop.id, orgId,
    // checkInStop's lat/lng args are required. Send 0/0 when we
    // couldn't get a fix — the audit payload's `distanceMi` will be
    // undefined so the server can tell this was unverified.
    coords?.lat ?? 0,
    coords?.lng ?? 0,
    audit ? {
      eventId:       audit.eventId,
      changedByName: audit.changedByName,
      stopFacility:  stop.facilityName ?? stop.city,
      stopType:      stop.type,
      distanceMi:    distMi,
    } : undefined,
  );

  return { usedLocation: coords !== null };
}

function CheckInButton({
  stop, orgId, onCheckedIn, eventId, driverName,
}: {
  stop: Stop; orgId?: string; onCheckedIn?: (action: "checkin") => void; eventId?: string; driverName?: string;
}) {
  const { C } = useTheme();
  const [busy, setBusy] = React.useState(false);

  async function handleCheckIn() {
    if (!orgId || busy) {
      if (!orgId) Alert.alert("Not ready", "Driver session not loaded yet.");
      return;
    }
    setBusy(true);
    try {
      const { usedLocation } = await performCheckIn(stop, orgId,
        eventId && driverName ? { eventId, changedByName: driverName } : undefined,
      );
      if (!usedLocation) {
        // Check-in succeeded but no GPS fix was available — let the
        // driver know it was recorded as unverified so they can
        // enable Location in Settings if they want their next stop
        // verified, but don't block them mid-trip.
        Alert.alert(
          "Checked in (no location)",
          "We couldn't get a GPS fix, so this check-in is unverified. "
          + "Enable Location for FleetCal Driver in Settings to verify future check-ins.",
        );
      }
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
        backgroundColor: C.bg,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={C.greenInk} />
      ) : (
        <>
          <MapPin size={13} color={C.greenInk} strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: C.greenInk }]}>Check In</Text>
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
  const { C } = useTheme();
  const [busy, setBusy] = React.useState(false);
  const distMi =
    stop.lat != null && stop.lng != null && stop.arrivedLat != null && stop.arrivedLng != null
      ? distanceMiles(stop.lat, stop.lng, stop.arrivedLat, stop.arrivedLng)
      : null;
  const verified = distMi != null && distMi <= VERIFY_THRESHOLD_MI;
  const palette = verified
    ? { bg: C.greenBg, fg: C.greenInk }
    : { bg: C.amberBg, fg: C.amberInk };
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
  const { C } = useTheme();
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
        backgroundColor: C.borderSoft,
        alignItems: "center", justifyContent: "center",
        borderWidth: 1, borderColor: C.border,
      }}
    >
      {copied ? (
        <Check size={14} color={C.greenInk} strokeWidth={2.6} />
      ) : (
        <Copy size={14} color={C.t3} strokeWidth={2.2} />
      )}
    </TouchableOpacity>
  );
}

function TimeAnchor({
  kind, iso,
}: { kind: "start" | "end"; iso?: string }) {
  const { C, ACCENT } = useTheme();
  const label = kind === "start" ? "START TIME" : "END TIME";
  const tint  = { bg: C.blueBg, fg: C.blueInk, iconBg: ACCENT };
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
        backgroundColor: C.surface,
        borderRadius:    18,
        marginBottom:    10,
        padding:         14,
        borderWidth:     1,
        borderColor:     C.border,
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
        <Text style={[txt(800), { fontSize: 15, color: C.t1 }]} numberOfLines={1}>
          {display}
        </Text>
      </View>
    </View>
  );
}

function StopCardInner({
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
  // Defensive lookup — if a new StopType ever gets added server-side
  // before the client knows about it, fall back to neutral colors
  // rather than crashing on undefined.iconBg. This belt-and-suspenders
  // is on top of the Record<Stop["type"], …> type guard above; the
  // TS check catches it at compile time, this catches it if a server
  // ever returns a value outside the union (e.g. older clients
  // hitting newer data).
  const { C, ACCENT, STOP_TINT, STOP_SOLID } = useTheme();
  const stint = STOP_TINT[stop.type] ?? { bg: C.surfaceSunk, fg: C.t3 };
  const accent = { bg: stint.bg, fg: stint.fg, iconBg: STOP_SOLID[stop.type] ?? C.t3 };
  const facility = stop.facilityName ?? stop.city ?? stop.address ?? "—";
  const copyValue = stop.address ?? stop.city ?? stop.facilityName ?? "";
  // Relay handoff stops carry two times in one row: apptStart = the
  // pickup-leg driver's drop, apptEnd = the delivery-leg driver's
  // pickup. Show only the time relevant to THIS driver instead of the
  // confusing "9a – 10a" range. Pair with a "DROP" / "PICKUP" subtype
  // label below so the role is unambiguous.
  const isRelayStop = stop.type === "relay" && !!relayRole;
  const relayActionLabel = isRelayStop
    ? (relayRole === "pickup" ? "DROP" : "PICKUP")
    : null;
  const relayTimeIso = isRelayStop
    ? (relayRole === "pickup" ? stop.apptStart : (stop.apptEnd ?? stop.apptStart))
    : null;
  const window = isRelayStop
    ? fmtTime(relayTimeIso ?? undefined)
    : (stop.apptStart && stop.apptEnd && stop.apptStart !== stop.apptEnd
        ? `${fmtTime(stop.apptStart)} – ${fmtTime(stop.apptEnd)}`
        : fmtTime(stop.apptStart));

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
        backgroundColor: C.surface,
        borderRadius: 18,
        marginBottom: 10,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: C.border,
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
                {/* Relay stops show "RELAY HANDOFF · DROP" or
                    "RELAY HANDOFF · PICKUP" so the driver immediately
                    knows what they're doing here. Non-relay stops use
                    the standard type label (PICKUP / DELIVERY / etc.). */}
                {isRelayStop
                  ? `RELAY HANDOFF · ${relayActionLabel}`
                  : (STOP_TYPE_LABEL[stop.type] ?? stop.type).toUpperCase()}
              </Text>
            </View>
          </View>

          <Text style={[txt(800), { fontSize: 16, color: C.t1 }]} numberOfLines={2}>
            {facility}
          </Text>
          {stop.address && stop.address !== facility ? (
            <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 2 }]} numberOfLines={2}>
              {stop.address}
            </Text>
          ) : null}

          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Clock size={12} color={C.t3} strokeWidth={2.2} />
              <Text style={[txt(700), { fontSize: 12, color: C.t2 }]}>
                {fmtDate(stop.apptStart)} · {window}
              </Text>
            </View>
            {/* Hide schedule type for relay handoff — it's not a real
                appointment, it's a fixed exchange time, so APPT/WINDOW
                doesn't add information. */}
            {!isRelayStop && <ScheduleTypeChip stop={stop} size="small" />}
          </View>
        </View>
      </View>

      {/* Navigate + Check In row */}
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: C.borderSoft }}>
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
            backgroundColor: C.bg,
          }}
        >
          <Navigation size={13} color={ACCENT} strokeWidth={2.4} />
          <Text style={[txt(700), { fontSize: 13, color: ACCENT }]}>Navigate</Text>
        </TouchableOpacity>

        <View style={{ width: 1, backgroundColor: C.borderSoft }} />

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
              backgroundColor: C.purpleBg,
              borderTopWidth: 1, borderTopColor: C.borderSoft,
            }}
          >
            <FileText size={14} color={C.purpleInk} strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: C.purpleInk, letterSpacing: 0.2 }]}>
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
              backgroundColor: C.purpleBg,
              borderTopWidth: 1, borderTopColor: C.borderSoft,
            }}
          >
            <Camera size={14} color={C.purpleInk} strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: C.purpleInk, letterSpacing: 0.2 }]}>
              Upload Pictures
            </Text>
          </TouchableOpacity>
        )
      ) : null}

      {stop.instructions ? (
        <View style={{ paddingHorizontal: 14, paddingVertical: 12, backgroundColor: C.amberBg, borderTopWidth: 1, borderTopColor: C.borderSoft }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
            <Info size={13} color={C.amberInk} strokeWidth={2.2} style={{ marginTop: 2 }} />
            <ExpandableInstructions
              value={stop.instructions}
              textStyle={{ ...txt(600), fontSize: 13, color: C.amberInk, lineHeight: 18 }}
              toggleColor={C.amberInk}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Memoized StopCard — for big loads (e.g. 18-stop runs) re-rendering
 * every card on every parent state change blows the JS thread and the
 * iPhone's memory budget, which had been crashing the load detail
 * screen on cold mount. The comparator below intentionally ignores
 * handler-prop identity: the inline arrows recreate every render but
 * their behavior is fully determined by stable closures (queryClient,
 * showToast — both already stable refs), so a fresh arrow with the
 * same closed-over state is behavior-equivalent.
 *
 * Re-renders are still triggered by what actually matters: a change
 * to the stop's data, its index, the relay role flag, or the driver
 * context. That covers every meaningful update (check-in stamp, edit
 * etc.) without thrashing on truck-location ticks / pager swipes /
 * toast state.
 */
const StopCard = React.memo(StopCardInner, (prev, next) => (
  prev.stop       === next.stop       &&
  prev.index      === next.index      &&
  prev.relayRole  === next.relayRole  &&
  prev.driverName === next.driverName &&
  prev.orgId      === next.orgId      &&
  prev.eventId    === next.eventId    &&
  prev.loadId     === next.loadId
));

export default function LoadDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { C, SHADOW, ACCENT } = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const insets = useSafeAreaInsets();
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
  // Outer ScrollView of the Stops tab + Y offset of the embedded route
  // map block. Wired together so the AssignedTruckCard's "View on Map"
  // action can scroll the map into view from above the fold.
  const stopsScrollRef = React.useRef<ScrollView>(null);
  const [routeMapY, setRouteMapY] = useState<number>(0);
  // Imperative handle for the RouteMap — lets AssignedTruckCard's
  // "View on Map" button open fullscreen + pan to the truck pin in
  // a single tap, rather than just scrolling to the thumbnail.
  const routeMapRef = React.useRef<RouteMapHandle | null>(null);

  // Lazy-mount the RouteMap WebView. The WebView allocates its own
  // JS engine + Google Maps SDK + 18 marker overlays for a big-stop
  // load, all of which compete with the StopCards for the JS thread
  // and native memory during cold mount. iPhone drivers on 18-stop
  // loads were crashing here. Deferring the mount until AFTER the
  // first paint settles lets the screen become interactive (and
  // memory-stable) before the heavy WebView allocates. The user
  // doesn't notice the ~300ms shift because the screen is
  // already responsive by then.
  const [mapMounted, setMapMounted] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setMapMounted(true);
    });
    return () => task.cancel();
  }, []);
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

  // Motive ELD module gate. New MVP orgs have motive_integration OFF, so
  // there's no live truck location to show — hide the locate actions and
  // skip polling Motive entirely. Curzon (absent flag) stays enabled.
  const eldEnabled = isModuleEnabled("motive_integration", orgSettings?.modules);

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
    enabled:  !!id && !!driver && eldEnabled,
    // Poll once every 2 min while the screen is open and the app is
    // foregrounded. focusManager (wired at the root) automatically
    // pauses this when the driver backgrounds the app, so the Motive
    // quota only burns while the driver is actually looking.
    refetchInterval: 2 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const { mutate: confirmLoadMut, isPending: isConfirming } = useMutation({
    mutationFn: () => confirmLoad(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["load", id] });
      queryClient.invalidateQueries({ queryKey: ["loads"] });
      showToast("Load confirmed");
    },
    onError: () => {
      showToast("Couldn't confirm — try again");
    },
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
      <View style={{ flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  // Start Trip is always available — even on scheduled loads — so a
  // driver who skipped the green Confirm banner can still launch the
  // trip. The server stamps confirmed_at automatically on the status
  // advance, so dispatch sees the acknowledgment either way.
  const nextStatus  = STATUS_TRANSITIONS[load.status];
  const ctaLabel    = STATUS_CTA[load.status];

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
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="dark" />

      {/* Glass header */}
      <Glass
        deep
        radii={{ borderBottomLeftRadius: RADIUS.headerDetail, borderBottomRightRadius: RADIUS.headerDetail }}
        style={{ paddingTop: insets.top + 6, paddingHorizontal: SP.screenPx, paddingBottom: 11, flexDirection: "row", alignItems: "center", gap: 10, zIndex: 10 }}
      >
        <TouchableOpacity
          onPress={() => {
            if (router.canGoBack()) router.back();
            else router.replace("/");
          }}
          activeOpacity={0.7}
          style={{ width: 40, height: 40, borderRadius: RADIUS.iconBtn, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center" }}
        >
          <ArrowLeft size={20} color={C.t2} strokeWidth={2.4} />
        </TouchableOpacity>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[txt(800), { fontSize: 17, color: C.t1, letterSpacing: -0.3 }]} numberOfLines={1}>
            {load.title}
          </Text>
          {load.eventKind === "non_revenue" ? (
            <View style={{
              alignSelf: "flex-start",
              flexDirection: "row", alignItems: "center", gap: 5,
              paddingHorizontal: 7, paddingVertical: 2,
              marginTop: 3,
              borderRadius: 999,
              backgroundColor: C.amberBg,
            }}>
              <Text style={[txt(800), { fontSize: 9, color: C.amberInk, letterSpacing: 0.4 }]}>
                NON-REVENUE
              </Text>
              {load.nonRevenueType ? (
                <>
                  <Text style={[txt(700), { fontSize: 9, color: C.amberInk }]}>·</Text>
                  <Text style={[txt(800), { fontSize: 9, color: C.amberInk, letterSpacing: 0.3 }]} numberOfLines={1}>
                    {load.nonRevenueType.toUpperCase()}
                  </Text>
                </>
              ) : null}
            </View>
          ) : load.loadNum || load.broker ? (
            <Text style={[txt(700), { fontSize: 12, color: C.blueInk, marginTop: 1 }]} numberOfLines={1}>
              {load.loadNum ? `#${load.loadNum}` : ""}{load.loadNum && load.broker ? " · " : ""}{load.broker ?? ""}
            </Text>
          ) : null}
        </View>
        <TouchableOpacity
          onPress={() => setStatusPickerVisible(true)}
          activeOpacity={0.7}
          style={{ width: 40, height: 40, borderRadius: RADIUS.iconBtn, backgroundColor: C.surface2, alignItems: "center", justifyContent: "center" }}
        >
          <CircleDot size={20} color={C.t2} strokeWidth={2.4} />
        </TouchableOpacity>
      </Glass>

      {/* Segmented control */}
      <View style={{ paddingHorizontal: SP.screenPx, paddingTop: 12, paddingBottom: 2, zIndex: 5 }}>
        <View style={{ flexDirection: "row", gap: 3, padding: 4, borderRadius: 18, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, ...SHADOW.card }}>
          {(["Stops", "Details", "Documents"] as const).map((label, i) => {
            const isActive = tab === i;
            return (
              <TouchableOpacity
                key={label}
                onPress={() => selectTab(i as 0 | 1 | 2)}
                activeOpacity={0.8}
                style={[
                  { flex: 1, height: 34, borderRadius: 11, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5 },
                  isActive && { backgroundColor: ACCENT },
                ]}
              >
                <Text style={[txt(700), { fontSize: 13, color: isActive ? "#ffffff" : C.t3 }]}>{label}</Text>
                {label === "Stops" ? (
                  <Text style={[txt(800), { fontSize: 11, color: isActive ? "rgba(255,255,255,0.85)" : C.t4 }]}>{load.stops.length}</Text>
                ) : null}
              </TouchableOpacity>
            );
          })}
        </View>
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
      <ScrollView
        ref={stopsScrollRef}
        style={{ width: SCREEN_W, backgroundColor: C.bg }}
        contentContainerStyle={{ padding: 16, paddingBottom: 120 }}
        nestedScrollEnabled
        // Detach off-screen subviews from the native view hierarchy.
        // For a long stops list (18+) this drops the live native view
        // count significantly — only ~6-8 stop cards live in the
        // hierarchy at any time, the rest are recycled. iOS doesn't
        // OOM on the cold mount anymore. Safe on this ScrollView
        // because nothing inside relies on off-screen view refs.
        removeClippedSubviews
      >
        {/* Pending dispatcher nudges — surfaces every kind the dispatcher
            has asked for that's still unacknowledged. Driver sees a
            clear list of what's needed without having to remember the
            push. Pulls from load_notifications via the loads endpoint. */}
        {(() => {
          const pending = load.pendingNotificationKinds ?? [];
          // This banner lists ACTION-required nudges only — things the
          // dispatcher asked the driver to actively do. Excludes:
          //   - 'confirm'         → has its own green "Confirm Load" button below
          //   - 'assigned'        → informational, just a heads-up about a new load
          //   - 'reassigned_away' → informational, load is no longer theirs
          //   - 'load_cancelled'  → informational, load is gone
          // Dedup by kind so the same ask doesn't render twice if the
          // dispatcher hit the popover button repeatedly.
          const ACTIONABLE = new Set([
            "mark_pickup", "mark_delivery", "upload_pod",
            "report_trailer", "upload_handoff",
          ]);
          const remaining = [...new Set(pending.filter(k => ACTIONABLE.has(k)))];
          if (remaining.length === 0) return null;
          const KIND_LABEL: Record<string, string> = {
            mark_pickup:    "Check in at pickup",
            mark_delivery:  "Check in at delivery + upload POD",
            upload_pod:     "Upload POD",
            report_trailer: "Report trailer",
            upload_handoff: "Upload trailer handoff photos",
          };
          return (
            <View style={{
              backgroundColor: C.amberBg,
              borderRadius: 12,
              borderWidth: 1, borderColor: C.amberBg,
              paddingVertical: 12, paddingHorizontal: 14,
              marginBottom: 14,
            }}>
              <Text style={[txt(800), { fontSize: 13, color: C.amberInk, marginBottom: 4 }]}>
                Dispatcher asked you to:
              </Text>
              {remaining.map((k) => (
                <Text key={k} style={[txt(600), { fontSize: 13, color: C.amberInk, lineHeight: 18 }]}>
                  • {KIND_LABEL[k] ?? k}
                </Text>
              ))}
            </View>
          );
        })()}

        {/* Confirm banner — only shown for unconfirmed assigned loads.
            Lets the driver acknowledge an upcoming load without yet
            advancing the status (e.g., the 7 PM evening sweep prompts
            them to confirm tomorrow's runs). */}
        {needsRunConfirmation(load) ? (
          <TouchableOpacity
            onPress={() => confirmLoadMut()}
            activeOpacity={0.85}
            disabled={isConfirming}
            style={{
              backgroundColor: C.green,
              borderRadius: 18,
              paddingVertical: 14,
              paddingHorizontal: 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
              shadowColor: C.green,
              shadowOpacity: 0.3,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            {isConfirming ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Check size={20} color="#ffffff" strokeWidth={3} />
            )}
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 15, color: "#ffffff" }]}>
                Confirm Load
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: "rgba(255,255,255,0.85)", marginTop: 1 }]}>
                Tap to let dispatch know you've got this run
              </Text>
            </View>
          </TouchableOpacity>
        ) : load.confirmedAt ? (
          <View style={{
            backgroundColor: C.greenBg,
            borderRadius: 12,
            paddingVertical: 10,
            paddingHorizontal: 14,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginBottom: 14,
          }}>
            <CheckCircle2 size={16} color={C.green} strokeWidth={2.4} />
            <Text style={[txt(700), { fontSize: 13, color: C.greenInk }]}>
              Confirmed
            </Text>
          </View>
        ) : null}

        {/* Assigned truck card — shown only while the load is still
            pre-pickup (status = scheduled or assigned). Once status moves to
            dispatched/en_route/etc, the driver is already in the truck
            and doesn't need to be reminded which one or how to find it.
            Surfaces the truck name, last-known location, View on Map +
            Navigate quick actions, and the standard "double-check with
            dispatch" disclaimer. When the org's Motive ELD module is
            off there's no live position, so it shows the truck name
            only (eldEnabled gates the location line + actions). */}
        {(load.status === "scheduled" || load.status === "assigned") && load.assetName && load.eventKind !== "non_revenue" && (
          <AssignedTruckCard
            assetName={load.assetName}
            eldEnabled={eldEnabled}
            assetColor={truckLoc?.color}
            truck={truckLoc ? {
              lat:          truckLoc.lat,
              lon:          truckLoc.lon,
              locatedAt:    truckLoc.locatedAt,
              description:  truckLoc.description,
            } : null}
            onViewOnMap={() => {
              // Two-step open: scroll the route map into view so the
              // user sees the transition, then expand it fullscreen and
              // pan onto the truck pin (and pop its info bubble open
              // via the focus-truck event). Falls back to plain scroll
              // when no live location is known.
              stopsScrollRef.current?.scrollTo({
                y: Math.max(0, routeMapY - 24),
                animated: true,
              });
              routeMapRef.current?.openOnTruck();
            }}
            onRefresh={async () => {
              // Force-bypass the API's per-org Motive cache so the
              // driver gets the freshest possible ping. We invalidate
              // the React Query cache key on success so the new data
              // flows into both the card AND the route map's truck
              // pin without a re-render gap.
              try {
                const fresh = await railway.getTruckLocation(id!, { force: true });
                queryClient.setQueryData(["truck-location", id], fresh);
              } catch (err) {
                showToast("Couldn't refresh truck location");
                console.warn("[truck-location] force refresh:", err);
              }
            }}
          />
        )}

        {/* Route map — deferred so cold mount doesn't compete with the
            stop-card render. Same fixed height (220px) for the
            placeholder so nothing jumps when the WebView swaps in. */}
        <View
          style={{ marginBottom: 14 }}
          onLayout={(e) => setRouteMapY(e.nativeEvent.layout.y)}
        >
          {mapMounted ? (
            <RouteMap
              ref={routeMapRef}
              stops={load.stops}
              truckLat={truckLoc?.lat}
              truckLng={truckLoc?.lon}
              assetColor={truckLoc?.color}
              truckDescription={truckLoc?.description}
              truckLocatedAt={truckLoc?.locatedAt}
            />
          ) : (
            <View
              style={{
                height: 220,
                backgroundColor: C.borderSoft,
                borderRadius: 18,
                alignItems: "center",
                justifyContent: "center",
                borderWidth: 1,
                borderColor: C.border,
              }}
            >
              <ActivityIndicator color={C.t4} />
            </View>
          )}
        </View>

        {/* Start time → stops → End time, joined by a vertical timeline rail. */}
        <View style={{ position: "relative" }}>
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              left: 33, top: 30, bottom: 30, width: 2,
              backgroundColor: C.borderStrong,
              borderRadius: 1,
            }}
          />

        {/* Start time */}
        <TimeAnchor kind="start" iso={load.start} />

        {load.stops.length === 0 ? (
          <Text style={[txt(500), { fontSize: 13, color: C.t4, marginBottom: 14 }]}>
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
                        { fontSize: 11, letterSpacing: 1.1, color: C.t4, marginBottom: 10, textTransform: "uppercase" },
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
                        style={{ position: "absolute", left: 28, width: 12, top: 0, bottom: 0, backgroundColor: C.bg }}
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
                      { fontSize: 11, letterSpacing: 1.1, color: C.t4, marginBottom: 10, textTransform: "uppercase" },
                    ]}
                  >
                    Completed by partner
                  </Text>
                  {/* Mask the timeline rail behind the dimmed partner
                      section — see matching block in the pickup-leg path. */}
                  <View style={{ position: "relative" }}>
                    <View
                      pointerEvents="none"
                      style={{ position: "absolute", left: 28, width: 12, top: 0, bottom: 0, backgroundColor: C.bg }}
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
      <ScrollView style={{ width: SCREEN_W, backgroundColor: C.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }} nestedScrollEnabled>
        {/* Relay disclaimer + handoff photos. Photos are shared
            across both legs (`kind='relay_handoff'` on load_documents).
            Pickup driver leaves "where I parked the trailer" / paperwork
            shots; delivery driver picks them up. */}
        {load.relayGroupId && load.loadId ? (
          <View
            style={{
              backgroundColor: C.purpleBg,
              borderRadius: 18,
              padding: 14,
              borderWidth: 1, borderColor: C.purpleBg,
              marginBottom: 14,
            }}
          >
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Repeat2 size={20} color={C.purpleInk} strokeWidth={2.2} style={{ marginTop: 2 }} />
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 13, color: C.purpleInk, letterSpacing: 0.2 }]}>
                  Relay Load — {load.relayRole === "pickup" ? "First Leg" : "Second Leg"}
                </Text>
                <Text style={[txt(500), { fontSize: 13, color: C.purpleInk, lineHeight: 19, marginTop: 4, opacity: 0.95 }]}>
                  {load.relayRole === "pickup"
                    ? `You haul this load to the relay handoff point, then ${load.partnerDriverName ?? "another driver"} takes it the rest of the way.`
                    : `${load.partnerDriverName ?? "Another driver"} starts this load. You pick it up at the relay point and finish the delivery.`}
                </Text>
              </View>
            </View>
            <RelayHandoffPhotos loadId={load.id} reloadKey={relayPhotosReloadKey} />
            {/* RelayTrailerLocation (the trailer-drop pin feature) was
                hidden 2026-05-22 — too complex for the prototype.
                Component + API + schema stay in place so re-enabling
                is just uncommenting this block. */}
          </View>
        ) : null}

        {/* References */}
        {(load.internalLoadId || load.loadNum || (load.refNums && load.refNums.length > 0)) && (
          <View
            style={{
              backgroundColor: C.surface,
              borderRadius: 18,
              paddingHorizontal: 14,
              borderWidth: 1, borderColor: C.border,
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
            backgroundColor: C.surface,
            borderRadius: 18,
            padding: 14,
            borderWidth: 1, borderColor: C.border,
            marginBottom: 18,
          }}
        >
          {load.broker      ? <MetaRow Icon={Building2} label="Customer" value={load.broker}      /> : null}
          {load.assetName   ? <MetaRow Icon={Truck}     label="Truck"   value={load.assetName}   /> : null}
          {load.trailerType ? <MetaRow Icon={Container} label="Equipment Type" value={load.trailerType} /> : null}
          <TouchableOpacity onPress={() => setTrailerPickerVisible(true)} activeOpacity={0.6}>
            <MetaRow
              Icon={Container}
              label="Trailer"
              value={load.trailerName ?? "Tap to select"}
              color={load.trailerName ? C.t1 : ACCENT}
            />
          </TouchableOpacity>
          {load.driverPay != null && orgSettings?.showDriverPay ? (
            <MetaRow
              Icon={DollarSign}
              label="Pay"
              value={`$${load.driverPay.toLocaleString("en-US", { minimumFractionDigits: 2 })}`}
              color={C.greenInk}
            />
          ) : null}
        </View>


        {/* Special Instructions — load.notes is canonical, specialInstructions is legacy fallback */}
        {(load.notes || load.specialInstructions) ? (
          <>
            <Text
              style={[
                txt(800),
                { fontSize: 11, letterSpacing: 1.1, color: C.t3, marginTop: 16, marginBottom: 10, textTransform: "uppercase" },
              ]}
            >
              Special Instructions
            </Text>
            <View
              style={{
                backgroundColor: C.amberBg,
                borderRadius: 12,
                padding: 12,
                flexDirection: "row",
                gap: 10,
                borderWidth: 1,
                borderColor: C.amberBg,
              }}
            >
              <AlertTriangle size={15} color={C.amberInk} strokeWidth={2.2} style={{ marginTop: 2 }} />
              <SelectableText
                value={load.notes ?? load.specialInstructions ?? ""}
                style={{ ...txt(600), fontSize: 13, color: C.amberInk, flex: 1, lineHeight: 18 }}
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

      {/* Floating status dock */}
      {ctaLabel && nextStatus ? (
        <Glass
          deep
          radii={{ borderRadius: 22 }}
          style={{ position: "absolute", left: 14, right: 14, bottom: Math.max(insets.bottom, 12) + 6, padding: 11, flexDirection: "row", alignItems: "center", gap: 11 }}
        >
          <View style={{ flex: 1, minWidth: 0, paddingLeft: 6 }}>
            <Text style={[txt(800), { fontSize: 10, letterSpacing: 0.5, color: C.t3 }]}>STATUS</Text>
            <Text style={[txt(800), { fontSize: 15, color: C.t1, marginTop: 1, letterSpacing: -0.2 }]} numberOfLines={1}>
              {load.status.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleStatusUpdate}
            activeOpacity={0.92}
            disabled={isPending}
            style={{
              height: 50, paddingHorizontal: 22, borderRadius: 15,
              backgroundColor: nextStatus === "delivered" ? C.green : ACCENT,
              alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8,
              ...SHADOW.card,
            }}
          >
            {isPending ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: -0.2 }]}>{ctaLabel}</Text>
            )}
          </TouchableOpacity>
        </Glass>
      ) : load.status === "delivered" ? (
        <Glass
          deep
          radii={{ borderRadius: 22 }}
          style={{ position: "absolute", left: 14, right: 14, bottom: Math.max(insets.bottom, 12) + 6, padding: 11 }}
        >
          <View style={{ height: 50, borderRadius: 15, backgroundColor: C.green, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }}>
            <CheckCircle2 size={18} color="#ffffff" strokeWidth={2.4} />
            <Text style={[txt(800), { fontSize: 15, color: "#ffffff", letterSpacing: -0.2 }]}>Delivered</Text>
          </View>
        </Glass>
      ) : null}

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
    </View>
  );
}
