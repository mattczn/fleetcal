import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { MapPin, Truck, ChevronRight, User } from "lucide-react-native";
import type { Load, LoadStatus, Stop } from "@/lib/types";
import { txt } from "@/lib/font";

const STATUS_TINT: Record<LoadStatus, { bg: string; fg: string }> = {
  scheduled:  { bg: "#f1f3f4", fg: "#5f6368" },
  dispatched: { bg: "#e8f0fe", fg: "#1558d6" },
  en_route:   { bg: "#fef3c7", fg: "#92400e" },
  picked_up:  { bg: "#f3e8fd", fg: "#6b21a8" },
  delivered:  { bg: "#e6f4ea", fg: "#15803d" },
  cancelled:  { bg: "#fce8e6", fg: "#b91c1c" },
  tonu:       { bg: "#fef3c7", fg: "#92400e" },
  problem:    { bg: "#fef0e6", fg: "#b85c00" },
};

const STATUS_LABEL: Record<LoadStatus, string> = {
  scheduled:  "Scheduled",
  dispatched: "Dispatched",
  en_route:   "En Route",
  picked_up:  "Picked Up",
  delivered:  "Delivered",
  cancelled:  "Cancelled",
  tonu:       "TONU",
  problem:    "Problem",
};

function pickupOf(load: Load): Stop | undefined {
  return load.stops.find((s) => s.type === "pickup");
}
function deliveryOf(load: Load): Stop | undefined {
  return [...load.stops].reverse().find((s) => s.type === "delivery" || s.type === "drop_hook");
}

function fmtDate(iso: string): string {
  const d = new Date(iso.replace(" ", "T"));
  if (isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function locLabel(s?: Stop): string {
  if (!s) return "—";
  return s.city ?? s.facilityName ?? s.address ?? "—";
}

export function LoadResultCard({ load }: { load: Load }) {
  const router  = useRouter();
  const status  = STATUS_TINT[load.status] ?? STATUS_TINT.scheduled;
  const pickup  = pickupOf(load);
  const delivery = deliveryOf(load);

  return (
    <TouchableOpacity
      onPress={() => router.push({ pathname: "/load/[id]", params: { id: load.id } })}
      activeOpacity={0.85}
      style={{
        backgroundColor: "#ffffff",
        borderRadius: 14,
        padding: 14,
        marginBottom: 10,
        borderWidth: 1, borderColor: "#e8eaed",
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 6 }}>
        <Text style={[txt(800), { fontSize: 12, color: "#1a73e8", flex: 1 }]} numberOfLines={1}>
          {load.loadNum ? `Load #${load.loadNum}` : fmtDate(load.start)}
        </Text>
        <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: status.bg }}>
          <Text style={[txt(700), { fontSize: 10, color: status.fg, letterSpacing: 0.3 }]}>
            {STATUS_LABEL[load.status]}
          </Text>
        </View>
      </View>

      <Text style={[txt(800), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
        {load.title}
      </Text>

      {pickup || delivery ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 6 }}>
          <MapPin size={11} color="#5f6368" strokeWidth={2.2} />
          <Text style={[txt(600), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
            {locLabel(pickup)} → {locLabel(delivery)}
          </Text>
        </View>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8, gap: 12 }}>
        <Text style={[txt(700), { fontSize: 11, color: "#9aa0a6" }]}>{fmtDate(load.start)}</Text>
        {load.assetName ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Truck size={11} color="#5f6368" strokeWidth={2.2} />
            <Text style={[txt(700), { fontSize: 11, color: "#3c4043" }]} numberOfLines={1}>
              {load.assetName}
            </Text>
          </View>
        ) : null}
        {load.driverName ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <User size={11} color="#5f6368" strokeWidth={2.2} />
            <Text style={[txt(700), { fontSize: 11, color: "#3c4043" }]} numberOfLines={1}>
              {load.driverName}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        <ChevronRight size={14} color="#9aa0a6" strokeWidth={2.2} />
      </View>
    </TouchableOpacity>
  );
}
