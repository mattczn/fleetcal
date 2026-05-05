import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { ChevronRight } from "lucide-react-native";
import type { Load } from "@/lib/types";
import { txt } from "@/lib/font";
import {
  STATUS_TINT, STATUS_LABEL, showStatusPill,
  fmtTimeRange, fmtCardDate, loadNumLabel,
} from "@/lib/loadCard";

/**
 * Search-result card. Cross-asset and cross-day, so line 2 carries the
 * asset+driver and line 3 includes the date alongside load # / time.
 */
export function LoadResultCard({ load }: { load: Load }) {
  const router = useRouter();
  const tint   = STATUS_TINT[load.status] ?? STATUS_TINT.scheduled;

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
      <Text style={[txt(800), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
        {load.title}
      </Text>

      {load.assetName || load.driverName ? (
        <Text style={[txt(600), { fontSize: 12, color: "#3c4043", marginTop: 3 }]} numberOfLines={1}>
          {[load.assetName, load.driverName].filter(Boolean).join(" · ")}
        </Text>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 }}>
        <Text style={[txt(700), { fontSize: 11, color: "#1a73e8" }]} numberOfLines={1}>
          {loadNumLabel(load)}
        </Text>
        <Text style={[txt(600), { fontSize: 11, color: "#9aa0a6" }]}>·</Text>
        <Text style={[txt(600), { fontSize: 11, color: "#5f6368" }]} numberOfLines={1}>
          {fmtCardDate(load.start)}
        </Text>
        <Text style={[txt(600), { fontSize: 11, color: "#9aa0a6" }]}>·</Text>
        <Text style={[txt(600), { fontSize: 11, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
          {fmtTimeRange(load)}
        </Text>
        {showStatusPill(load.status) ? (
          <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: tint.bg }}>
            <Text style={[txt(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.3 }]}>
              {STATUS_LABEL[load.status]}
            </Text>
          </View>
        ) : null}
        <ChevronRight size={14} color="#9aa0a6" strokeWidth={2.2} />
      </View>
    </TouchableOpacity>
  );
}
