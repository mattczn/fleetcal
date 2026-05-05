import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { ChevronUp, ChevronDown, Pencil, Trash2 } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Stop, StopType } from "@/lib/types";

const STOP_TINT: Record<StopType, { bg: string; fg: string; mark: string; label: string }> = {
  pickup:    { bg: "#dcfce7", fg: "#15803d", mark: "#16a34a", label: "Pickup" },
  delivery:  { bg: "#fee2e2", fg: "#b91c1c", mark: "#dc2626", label: "Delivery" },
  drop:      { bg: "#cffafe", fg: "#0e7490", mark: "#0891b2", label: "Drop Trailer" },
  drop_hook: { bg: "#dbeafe", fg: "#1e40af", mark: "#2563eb", label: "Drop & Hook" },
  stop:      { bg: "#fef9c3", fg: "#854d0e", mark: "#eab308", label: "Stop" },
  relay:     { bg: "#f3e8fd", fg: "#6b21a8", mark: "#8b5cf6", label: "Relay" },
};

interface Props {
  stop:     Stop;
  index:    number;
  isFirst:  boolean;
  isLast:   boolean;
  onTap:    () => void;
  onUp:     () => void;
  onDown:   () => void;
  onDelete: () => void;
}

export function EditableStopCard({
  stop, index, isFirst, isLast, onTap, onUp, onDown, onDelete,
}: Props) {
  const tint = STOP_TINT[stop.type] ?? STOP_TINT.stop;
  const facility = stop.facilityName ?? stop.city ?? stop.address ?? "Untitled stop";
  const hasCoords = stop.lat != null && stop.lng != null;
  return (
    <View
      style={{
        flexDirection: "row", alignItems: "center", gap: 8,
        backgroundColor: "#ffffff", borderRadius: 14,
        borderWidth: 1, borderColor: "#e8eaed",
        padding: 10, marginBottom: 10,
      }}
    >
      <View style={{ alignItems: "center", justifyContent: "center", gap: 2 }}>
        <TouchableOpacity
          onPress={onUp}
          disabled={isFirst}
          hitSlop={6}
          style={{
            width: 28, height: 24, borderRadius: 8,
            backgroundColor: isFirst ? "#f1f3f4" : "#e8f0fe",
            alignItems: "center", justifyContent: "center",
            opacity: isFirst ? 0.4 : 1,
          }}
        >
          <ChevronUp size={14} color={isFirst ? "#9aa0a6" : "#1a73e8"} strokeWidth={2.4} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onDown}
          disabled={isLast}
          hitSlop={6}
          style={{
            width: 28, height: 24, borderRadius: 8,
            backgroundColor: isLast ? "#f1f3f4" : "#e8f0fe",
            alignItems: "center", justifyContent: "center",
            opacity: isLast ? 0.4 : 1,
          }}
        >
          <ChevronDown size={14} color={isLast ? "#9aa0a6" : "#1a73e8"} strokeWidth={2.4} />
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        onPress={onTap}
        activeOpacity={0.7}
        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}
      >
        <View style={{
          width: 32, height: 32, borderRadius: 10,
          backgroundColor: tint.mark,
          alignItems: "center", justifyContent: "center",
        }}>
          <Text style={[txt(800), { color: "#ffffff", fontSize: 14 }]}>{index + 1}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View style={{ paddingHorizontal: 6, paddingVertical: 1, borderRadius: 999, backgroundColor: tint.bg }}>
              <Text style={[txt(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.4 }]}>
                {tint.label.toUpperCase()}
              </Text>
            </View>
            {!hasCoords ? (
              <Text style={[txt(700), { fontSize: 10, color: "#b91c1c" }]}>· unverified</Text>
            ) : null}
          </View>
          <Text style={[txt(800), { fontSize: 14, color: "#202124", marginTop: 2 }]} numberOfLines={1}>
            {facility}
          </Text>
          {stop.address && stop.address !== facility ? (
            <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 1 }]} numberOfLines={1}>
              {stop.address}
            </Text>
          ) : null}
        </View>
        <Pencil size={13} color="#1a73e8" strokeWidth={2.4} />
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onDelete}
        hitSlop={6}
        style={{
          width: 30, height: 30, borderRadius: 10,
          backgroundColor: "#fef2f2",
          borderWidth: 1, borderColor: "#fecaca",
          alignItems: "center", justifyContent: "center",
        }}
      >
        <Trash2 size={13} color="#b91c1c" strokeWidth={2.2} />
      </TouchableOpacity>
    </View>
  );
}
