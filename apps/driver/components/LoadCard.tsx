import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { MapPin, Truck, ChevronRight, Container, AlertTriangle, Bell, Route } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import type { Load, Stop } from "@/lib/types";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { useDriverSession } from "@/lib/useDriverSession";
import { needsRunConfirmation } from "@/lib/loadStatus";
import {
  RelayChip, NonRevChip,
  fmtTimeRangeShort, fmtStopAppt, fmtShortDate, fmtScheduleType,
  fmtRelayHandoffTime, relayHandoffAction,
} from "@/lib/loadCard";
import { legPositionOf, splitStopsForLeg, type LegStopWindow } from "@/lib/relayLegs";
import { f, SP, RADIUS } from "@/lib/theme";
import { useTheme } from "@/lib/ThemeProvider";

type Props = { load: Load };

/**
 * The "from" / "to" of this driver's leg — handles relays correctly.
 * `load.stops` contains the WHOLE load (origin → handoffs → final
 * delivery) on every leg of a relay, so we slice out this leg's window
 * (between its two boundary relay markers — see lib/relayLegs.ts) and
 * use its first/last stop as the card endpoints:
 *   - Single load:  first stop is pickup, last is delivery.
 *   - First leg:    origin is the real pickup, destination is my
 *                   outbound relay marker.
 *   - Middle leg:   BOTH endpoints are relay markers.
 *   - Final leg:    origin is my inbound relay marker, last stop is
 *                   the real delivery.
 */
function legWindowOf(load: Load): LegStopWindow | null {
  const pos = legPositionOf(load);
  if (!pos) return null;
  return splitStopsForLeg(load.stops, pos.legIndex);
}
function originLabel(s: Stop | undefined, startsAtHandoff: boolean): string {
  if (startsAtHandoff) return "RELAY HANDOFF";
  if (s?.type === "pickup") return "PICKUP";
  return "ORIGIN";
}
function destLabel(s: Stop | undefined, endsAtHandoff: boolean): string {
  if (endsAtHandoff) return "RELAY HANDOFF";
  if (s?.type === "delivery" || s?.type === "drop_hook") return "DELIVERY";
  return "DESTINATION";
}
function locLabel(s: Stop | undefined): string {
  if (!s) return "—";
  if (s.city && s.state) return `${s.city}, ${s.state}`;
  return s.city ?? s.facilityName ?? s.address ?? "—";
}
/** Facility sub-line — only when the place line already shows City, ST. */
function facilitySub(s: Stop | undefined): string | null {
  if (s?.city && s?.state && s.facilityName) return s.facilityName;
  return null;
}

/** Route-rail node — a tinted map-pin circle, colored by leg endpoint. */
function RouteNode({ kind }: { kind: "origin" | "dest" | "relay" }) {
  const { C } = useTheme();
  const tint =
    kind === "origin" ? { bg: C.greenBg, fg: C.green } :
    kind === "relay"  ? { bg: C.purpleBg, fg: C.purple } :
                        { bg: C.redBg, fg: C.red };
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: tint.bg, alignItems: "center", justifyContent: "center" }}>
      <MapPin size={12} color={tint.fg} strokeWidth={2.6} />
    </View>
  );
}

/** APPT / WINDOW / FCFS mini-chip. */
function MiniSched({ stop }: { stop?: Stop }) {
  const { SCHED_TINT } = useTheme();
  const label = fmtScheduleType(stop);
  if (!label) return null;
  const tint = SCHED_TINT[label as "APPT" | "WINDOW" | "FCFS"] ?? SCHED_TINT.FCFS;
  return (
    <View style={{ height: 16, paddingHorizontal: 6, borderRadius: 5, backgroundColor: tint.bg, justifyContent: "center" }}>
      <Text style={[f(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.4 }]}>{label}</Text>
    </View>
  );
}

export function LoadCard({ load }: Props) {
  const { C, SHADOW } = useTheme();
  const router = useRouter();
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;

  const legPos = legPositionOf(load);
  const win    = legWindowOf(load);
  const pickup   = win ? win.mine[0]                   : load.stops[0];
  const delivery = win ? win.mine[win.mine.length - 1] : load.stops[load.stops.length - 1];
  // Leg starts/ends at a relay marker — drives the RELAY HANDOFF labels
  // + purple tinting. A middle (transfer) leg has both.
  const startsAtHandoff = win?.inboundMarkerIdx  != null;
  const endsAtHandoff   = win?.outboundMarkerIdx != null;
  const isNonRev = load.eventKind === "non_revenue";
  // Caution chip when this load still needs the driver's run-confirmation —
  // mirrors the green Confirm banner inside the load detail so the driver
  // spots it in the list before opening.
  const needsConfirm = needsRunConfirmation(load);
  const destKind: "dest" | "relay" = delivery?.type === "relay" ? "relay" : "dest";

  // Pending dispatcher nudges (load_notifications WHERE acknowledged_at IS NULL).
  const pendingCount = (load.pendingNotificationKinds ?? []).length;

  // Delivered-without-POD warning (skips TONU, non-rev, and every
  // non-final relay leg — only the final leg is responsible for the POD).
  const podCount = load.documentCounts?.pod ?? 0;
  const missingPaperwork =
    load.status === "delivered" && !load.isTonu && !isNonRev && !endsAtHandoff && podCount === 0;

  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", driver?.orgId],
    queryFn: () => fetchOrgSettings(driver!.orgId),
    enabled: !!driver,
    staleTime: 5 * 60 * 1000,
  });
  const showPay = !!orgSettings?.showDriverPay && load.driverPay != null;

  // Bottom-stripe shows the leg's appt window (pickup start → delivery
  // end). Miles were previously shown when present and the time was
  // only a fallback — that made the same UI slot read inconsistently
  // across cards depending on whether loadedMiles had been entered
  // upstream. The time range is always known + always relevant, so use
  // it unconditionally.
  const metaLeft = fmtTimeRangeShort(load);

  // Eyebrow trailing text (date + appt window) per leg. Handoff endpoints
  // show only THIS driver's time on the marker (inbound → pickup time,
  // outbound → drop time) instead of the confusing two-driver range.
  const originExtra = startsAtHandoff
    ? `${relayHandoffAction("inbound").toUpperCase()}${fmtRelayHandoffTime(pickup, "inbound") ? ` · ${fmtRelayHandoffTime(pickup, "inbound")}` : ""}`
    : fmtStopAppt(pickup);
  const destExtra = endsAtHandoff
    ? `${relayHandoffAction("outbound").toUpperCase()}${fmtRelayHandoffTime(delivery, "outbound") ? ` · ${fmtRelayHandoffTime(delivery, "outbound")}` : ""}`
    : fmtStopAppt(delivery);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      style={{
        backgroundColor: C.surface,
        borderRadius: RADIUS.card,
        marginBottom: SP.cgap,
        overflow: "hidden",
        borderWidth: 1,
        borderColor: C.border,
        ...SHADOW.card,
      }}
    >
      {/* Title row */}
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: SP.cpad, paddingTop: SP.cpad }}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[f(800), { fontSize: 16.5, color: C.t1, letterSpacing: -0.3, lineHeight: 21 }]} numberOfLines={2}>
            {load.title}
          </Text>
          {load.loadNum || load.broker ? (
            <Text style={[f(700), { fontSize: 12, color: C.blueInk, marginTop: 3 }]} numberOfLines={1}>
              {load.loadNum ? `#${load.loadNum}` : ""}{load.loadNum && load.broker ? " · " : ""}{load.broker ?? ""}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: "flex-end", gap: 6 }}>
          {/* Status pill (Assigned / En Route / Picked Up / Delivered)
              was here. Dropped 2026-06-22 — too noisy on the card; the
              driver already knows the status from context (active vs
              upcoming vs recent tabs filter on it). Pending-nudge bell
              counter + relay / non-rev chips stay since those convey
              info the tab filter doesn't carry. */}
          {needsConfirm ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 21, borderRadius: 7, backgroundColor: C.amberBg }}>
              <AlertTriangle size={11} color={C.amberInk} strokeWidth={2.6} />
              <Text style={[f(800), { fontSize: 11, color: C.amberInk }]}>CONFIRM</Text>
            </View>
          ) : null}
          {pendingCount > 0 ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 21, borderRadius: 7, backgroundColor: C.red }}>
              <Bell size={11} color="#ffffff" strokeWidth={2.6} />
              <Text style={[f(800), { fontSize: 11, color: "#ffffff" }]}>{pendingCount > 99 ? "99+" : pendingCount}</Text>
            </View>
          ) : null}
          {isNonRev ? <NonRevChip size="small" /> : null}
          {legPos ? <RelayChip legIndex={legPos.legIndex} legCount={legPos.legCount} size="small" /> : null}
        </View>
      </View>

      {/* Paperwork warning strip */}
      {missingPaperwork ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: SP.cpad, marginTop: 10, paddingHorizontal: 11, paddingVertical: 9, borderRadius: 11, backgroundColor: C.amberBg }}>
          <AlertTriangle size={14} color={C.amberInk} strokeWidth={2.4} />
          <Text style={[f(700), { fontSize: 12, color: C.amberInk, flex: 1 }]} numberOfLines={1}>
            Upload paperwork — no POD on file
          </Text>
        </View>
      ) : null}

      {/* Equipment row */}
      {load.assetName || load.trailerType ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: SP.cpad, paddingTop: 10 }}>
          {load.assetName ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Truck size={13} color={C.t3} strokeWidth={2.2} />
              <Text style={[f(700), { fontSize: 12, color: C.t2 }]} numberOfLines={1}>{load.assetName}</Text>
            </View>
          ) : null}
          {load.trailerType ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
              <Container size={13} color={C.t3} strokeWidth={2.2} />
              <Text style={[f(700), { fontSize: 12, color: C.t2 }]} numberOfLines={1}>{load.trailerType}</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Route timeline */}
      <View style={{ flexDirection: "row", gap: 12, padding: SP.cpad }}>
        <View style={{ alignItems: "center", paddingTop: 3 }}>
          <RouteNode kind={startsAtHandoff ? "relay" : "origin"} />
          <View style={{ width: 2.5, flex: 1, minHeight: 26, marginVertical: 4, borderRadius: 2, borderLeftWidth: 2.5, borderColor: C.borderStrong, borderStyle: "dashed" }} />
          <RouteNode kind={endsAtHandoff ? "relay" : destKind === "relay" ? "relay" : "dest"} />
        </View>

        <View style={{ flex: 1, gap: 16 }}>
          {/* origin */}
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
              <Text style={[f(800), { fontSize: 10, letterSpacing: 0.5, color: startsAtHandoff ? C.purpleInk : C.greenInk }]}>
                {originLabel(pickup, startsAtHandoff)} · {fmtShortDate(load.start)}{originExtra ? ` · ${originExtra}` : ""}
              </Text>
              {!startsAtHandoff ? <MiniSched stop={pickup} /> : null}
            </View>
            <Text style={[f(700), { fontSize: 15, color: C.t1, marginTop: 2, letterSpacing: -0.2 }]} numberOfLines={1}>
              {locLabel(pickup)}
            </Text>
            {facilitySub(pickup) ? (
              <Text style={[f(600), { fontSize: 12, color: C.t3, marginTop: 1 }]} numberOfLines={1}>{facilitySub(pickup)}</Text>
            ) : null}
          </View>

          {/* destination */}
          <View>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 5 }}>
              <Text style={[f(800), { fontSize: 10, letterSpacing: 0.5, color: endsAtHandoff ? C.purpleInk : C.redInk }]}>
                {destLabel(delivery, endsAtHandoff)} · {fmtShortDate(load.end)}{destExtra ? ` · ${destExtra}` : ""}
              </Text>
              {!endsAtHandoff && destKind !== "relay" ? <MiniSched stop={delivery} /> : null}
            </View>
            <Text style={[f(700), { fontSize: 15, color: C.t1, marginTop: 2, letterSpacing: -0.2 }]} numberOfLines={1}>
              {locLabel(delivery)}
            </Text>
            {facilitySub(delivery) ? (
              <Text style={[f(600), { fontSize: 12, color: C.t3, marginTop: 1 }]} numberOfLines={1}>{facilitySub(delivery)}</Text>
            ) : null}
          </View>
        </View>
      </View>

      {/* Footer */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: SP.cpad, paddingVertical: 12, borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.surface2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flex: 1 }}>
          <Route size={13} color={C.t3} strokeWidth={2.2} />
          <Text style={[f(700), { fontSize: 12, color: C.t2, flex: 1 }]} numberOfLines={1}>{metaLeft}</Text>
        </View>
        {showPay ? (
          <Text style={[f(800), { fontSize: 15, color: C.greenInk, letterSpacing: -0.3 }]}>
            ${load.driverPay!.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
          </Text>
        ) : null}
        <ChevronRight size={17} color={C.t4} strokeWidth={2.4} />
      </View>
    </TouchableOpacity>
  );
}
