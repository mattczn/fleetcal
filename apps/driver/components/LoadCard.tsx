import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { MapPin, Truck, ChevronRight, Box } from "lucide-react-native";
import { useQuery } from "@tanstack/react-query";
import type { Load, Stop } from "@/lib/types";
import { StatusBadge } from "./StatusBadge";
import { needsConfirmation } from "@/lib/loadStatus";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { useDriverSession } from "@/lib/useDriverSession";

type Props = { load: Load };

function pickupOf(load: Load): Stop | undefined {
  return load.stops.find((s) => s.type === "pickup");
}
function deliveryOf(load: Load): Stop | undefined {
  return [...load.stops]
    .reverse()
    .find((s) => s.type === "delivery" || s.type === "drop_hook");
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTime(iso: string | undefined): string {
  if (!iso) return "";
  return iso.slice(11, 16);
}

function locLabel(s: Stop | undefined): string {
  if (!s) return "—";
  return s.city ?? s.facilityName ?? s.address ?? "—";
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
  const pickup   = pickupOf(load);
  const delivery = deliveryOf(load);
  const needsAction = needsConfirmation(load);
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
          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 15, color: "#202124" }]} numberOfLines={1}>
                {load.title}
              </Text>
              {load.loadNum ? (
                <Text style={[txt(700), { fontSize: 12, color: "#1a73e8", marginTop: 1 }]} numberOfLines={1}>
                  Load #{load.loadNum}
                </Text>
              ) : null}
            </View>
            <StatusBadge status={load.status} needsAction={needsAction} />
          </View>

          {/* Time range */}
          {(load.start || load.end) && (
            <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", letterSpacing: 0.2, marginBottom: 12 }]}>
              {load.start && load.end && load.start !== load.end
                ? `${fmtTime(load.start)} – ${fmtTime(load.end)}`
                : fmtTime(load.start || load.end)}
            </Text>
          )}

          {/* Route */}
          <View style={{ flexDirection: "row", alignItems: "stretch" }}>
            <View style={{ alignItems: "center", paddingTop: 4, marginRight: 12 }}>
              <View
                style={{
                  width: 20, height: 20, borderRadius: 10,
                  backgroundColor: "#dcfce7",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <MapPin size={11} color="#16a34a" strokeWidth={2.5} />
              </View>
              <View style={{ width: 2, flex: 1, backgroundColor: "#e8eaed", marginVertical: 4 }} />
              <View
                style={{
                  width: 20, height: 20, borderRadius: 10,
                  backgroundColor: "#fee2e2",
                  alignItems: "center", justifyContent: "center",
                }}
              >
                <MapPin size={11} color="#dc2626" strokeWidth={2.5} />
              </View>
            </View>

            <View style={{ flex: 1 }}>
              <View style={{ marginBottom: 12 }}>
                <Text style={[txt(700), { fontSize: 10, color: "#16a34a", letterSpacing: 0.6 }]}>
                  PICKUP · {fmtDate(load.start)}
                </Text>
                <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 2 }]} numberOfLines={1}>
                  {locLabel(pickup)}
                </Text>
              </View>

              <View>
                <Text style={[txt(700), { fontSize: 10, color: "#dc2626", letterSpacing: 0.6 }]}>
                  DELIVERY · {fmtDate(load.end)}
                </Text>
                <Text style={[txt(700), { fontSize: 14, color: "#202124", marginTop: 2 }]} numberOfLines={1}>
                  {locLabel(delivery)}
                </Text>
              </View>
            </View>
          </View>

          {/* Footer */}
          {(load.assetName || load.trailerType || showPay) && (
            <View
              style={{
                flexDirection: "row",
                alignItems:    "center",
                marginTop:     12,
                paddingTop:    12,
                borderTopWidth: 1,
                borderTopColor: "#f1f3f4",
                gap:            14,
              }}
            >
              {load.assetName ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Truck size={12} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]}>{load.assetName}</Text>
                </View>
              ) : null}
              {load.trailerType ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                  <Box size={12} color="#5f6368" strokeWidth={2.2} />
                  <Text style={[txt(700), { fontSize: 12, color: "#3c4043" }]}>{load.trailerType}</Text>
                </View>
              ) : null}
              {showPay ? (
                <Text style={[txt(800), { fontSize: 13, color: "#15803d", marginLeft: "auto" }]}>
                  ${load.driverPay!.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </Text>
              ) : null}
              <ChevronRight size={16} color="#9aa0a6" strokeWidth={2.2} />
            </View>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}
