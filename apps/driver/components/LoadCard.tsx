import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { MapPin, Truck, ChevronRight, Box } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import type { Load, Stop } from "@/lib/types";
import { needsConfirmation } from "@/lib/loadStatus";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { useDriverSession } from "@/lib/useDriverSession";
import {
  RelayChip, NonRevChip, StatusPill, DiagonalStripes,
  fmtTimeRangeShort, fmtStopAppt, fmtShortDate, loadNumLabel, fmtScheduleType,
} from "@/lib/loadCard";

type Props = { load: Load };

/**
 * The "from" / "to" of this driver's leg — handles relays correctly.
 *
 *   - Single load:    first stop is pickup, last is delivery.
 *   - Pickup leg:     first stop is pickup, last is the relay handoff.
 *   - Delivery leg:   first stop is the relay handoff, last is delivery.
 *
 * Looking up by stop.type === "pickup" missed relay-leg stops (which
 * are typed "relay"), so empty cells appeared on the home cards.
 */
function originStop(load: Load): Stop | undefined {
  return load.stops[0];
}
function destinationStop(load: Load): Stop | undefined {
  return load.stops[load.stops.length - 1];
}

function originLabel(s: Stop | undefined, isRelayDelivery: boolean): string {
  if (isRelayDelivery) return "RELAY HANDOFF";
  if (s?.type === "pickup")   return "PICKUP";
  return "ORIGIN";
}
function destLabel(s: Stop | undefined, isRelayPickup: boolean): string {
  if (isRelayPickup) return "RELAY HANDOFF";
  if (s?.type === "delivery" || s?.type === "drop_hook") return "DELIVERY";
  return "DESTINATION";
}

function locLabel(s: Stop | undefined): string {
  if (!s) return "—";
  // Drivers want the full street address — they're navigating to it.
  // Fall through to facility / city only when no address was geocoded.
  return s.address ?? s.facilityName ?? s.city ?? "—";
}

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

export function LoadCard({ load }: Props) {
  const router = useRouter();
  const session = useDriverSession();
  const driver = session.status === "matched" ? session.driver : null;
  const pickup     = originStop(load);
  const delivery   = destinationStop(load);
  const isRelayPickup   = load.relayRole === "pickup";
  const isRelayDelivery = load.relayRole === "delivery";
  const needsAction = needsConfirmation(load);
  const isNonRev   = load.eventKind === "non_revenue";
  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", driver?.orgId],
    queryFn:  () => fetchOrgSettings(driver!.orgId),
    enabled:  !!driver,
    staleTime: 5 * 60 * 1000,
  });
  const showPay = !!orgSettings?.showDriverPay && load.driverPay != null;

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      style={{
        backgroundColor: "#ffffff",
        borderRadius:    14,
        marginBottom:    10,
        overflow:        "hidden",
        borderWidth:     1,
        borderColor:     "#e8eaed",
        shadowColor:     "#000",
        shadowOpacity:   0.04,
        shadowRadius:    6,
        shadowOffset:    { width: 0, height: 2 },
      }}
    >
      <View style={{ flexDirection: "row" }}>
        <View style={{ width: 4, backgroundColor: needsAction ? "#dc2626" : "#1a73e8" }} />

        <View style={{ flex: 1, padding: 14 }}>
          {isNonRev ? <DiagonalStripes /> : null}

          {/* Title row — title + relay/non-rev chips */}
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6, flexWrap: "wrap" }}>
            <Text style={[txt(800), { fontSize: 15, color: "#202124", flex: 1, lineHeight: 20 }]} numberOfLines={2}>
              {load.title}
            </Text>
            {isNonRev ? <NonRevChip size="small" /> : null}
            {load.relayRole ? <RelayChip role={load.relayRole} size="small" /> : null}
          </View>

          {/* Equipment row — asset · trailer */}
          {(load.assetName || load.trailerType) ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 }}>
              {load.assetName ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Truck size={11} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]} numberOfLines={1}>
                    {load.assetName}
                  </Text>
                </View>
              ) : null}
              {load.trailerType ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Box size={11} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]} numberOfLines={1}>
                    {load.trailerType}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* Route timeline — pickup + delivery with date / appt window */}
          <View style={{ flexDirection: "row", alignItems: "stretch", marginTop: 12 }}>
            <View style={{ alignItems: "center", paddingTop: 4, marginRight: 12 }}>
              <View
                style={{
                  width: 20, height: 20, borderRadius: 10,
                  backgroundColor: isRelayDelivery ? "#ede9fe" : "#dcfce7",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <MapPin size={11} color={isRelayDelivery ? "#5b21b6" : "#16a34a"} strokeWidth={2.5} />
              </View>
              <View style={{ width: 2, flex: 1, backgroundColor: "#e8eaed", marginVertical: 4 }} />
              <View
                style={{
                  width: 20, height: 20, borderRadius: 10,
                  backgroundColor: isRelayPickup ? "#ede9fe" : "#fee2e2",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <MapPin size={11} color={isRelayPickup ? "#5b21b6" : "#dc2626"} strokeWidth={2.5} />
              </View>
            </View>

            <View style={{ flex: 1 }}>
              <View style={{ marginBottom: 12 }}>
                <Text style={[txt(700), {
                  fontSize: 10,
                  color: isRelayDelivery ? "#5b21b6" : "#16a34a",
                  letterSpacing: 0.6,
                }]}>
                  {originLabel(pickup, isRelayDelivery)} · {fmtShortDate(load.start)}
                  {fmtStopAppt(pickup) ? ` · ${fmtStopAppt(pickup)}` : ""}
                  {fmtScheduleType(pickup?.scheduleType) ? ` · ${fmtScheduleType(pickup?.scheduleType)}` : ""}
                </Text>
                <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 2 }]} numberOfLines={2}>
                  {locLabel(pickup)}
                </Text>
              </View>

              <View>
                <Text style={[txt(700), {
                  fontSize: 10,
                  color: isRelayPickup ? "#5b21b6" : "#dc2626",
                  letterSpacing: 0.6,
                }]}>
                  {destLabel(delivery, isRelayPickup)} · {fmtShortDate(load.end)}
                  {fmtStopAppt(delivery) ? ` · ${fmtStopAppt(delivery)}` : ""}
                  {fmtScheduleType(delivery?.scheduleType) ? ` · ${fmtScheduleType(delivery?.scheduleType)}` : ""}
                </Text>
                <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 2 }]} numberOfLines={2}>
                  {locLabel(delivery)}
                </Text>
              </View>
            </View>
          </View>

          {/* Meta row — load # · time range · [status] · [pay] · chevron */}
          <View
            style={{
              flexDirection:  "row",
              alignItems:     "center",
              marginTop:      12,
              paddingTop:     12,
              borderTopWidth: 1,
              borderTopColor: "#f1f3f4",
              gap:            6,
            }}
          >
            <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]} numberOfLines={1}>
              {loadNumLabel(load)}
            </Text>
            <Text style={[txt(600), { fontSize: 12, color: "#9aa0a6" }]}>·</Text>
            <Text style={[txt(600), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
              {fmtTimeRangeShort(load)}
            </Text>
            <StatusPill status={load.status} size="small" />
            {showPay ? (
              <Text style={[txt(800), { fontSize: 13, color: "#15803d" }]}>
                ${load.driverPay!.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              </Text>
            ) : null}
            <ChevronRight size={16} color="#9aa0a6" strokeWidth={2.2} />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}
