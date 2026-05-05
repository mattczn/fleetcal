import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, FlatList } from "react-native";
import { X, Truck, MapPin } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Load, LoadStatus, Stop } from "@/lib/types";

const STATUS_TINT: Record<LoadStatus, { bg: string; fg: string }> = {
  scheduled:  { bg: "#f1f3f4", fg: "#5f6368" },
  assigned:   { bg: "#ede9fe", fg: "#5b21b6" },
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
  assigned:   "Assigned",
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
function locLabel(s?: Stop): string {
  if (!s) return "—";
  return s.city ?? s.facilityName ?? s.address ?? "—";
}

interface Props {
  visible:  boolean;
  loads:    Load[];
  /** Asset color lookup keyed by assetId, for the leading swatch. */
  assetColorById: Map<number, string>;
  onClose:  () => void;
  onSelect: (load: Load) => void;
}

export function ActiveLoadsSheet({ visible, loads, assetColorById, onClose, onSelect }: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            maxHeight: "80%",
            paddingBottom: 28, paddingTop: 8,
          }}
        >
          <View style={{
            flexDirection: "row", alignItems: "center",
            paddingHorizontal: 18, paddingVertical: 14,
            borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
          }}>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 16, color: "#202124" }]}>
                Active Routes
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
                Tap a load to map its route.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {loads.length === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                No loads in progress right now.
              </Text>
            </View>
          ) : (
            <FlatList
              data={loads}
              keyExtractor={(l) => l.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: load }) => {
                const tint = STATUS_TINT[load.status];
                const color = assetColorById.get(load.assetId) ?? "#1a73e8";
                const pickup = pickupOf(load);
                const delivery = deliveryOf(load);
                return (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => onSelect(load)}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 12,
                      paddingHorizontal: 18, paddingVertical: 14,
                      borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
                    }}
                  >
                    <View style={{
                      width: 36, height: 36, borderRadius: 10,
                      backgroundColor: color,
                      alignItems: "center", justifyContent: "center",
                    }}>
                      <Truck size={16} color="#ffffff" strokeWidth={2.2} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 2 }}>
                        <Text style={[txt(700), { fontSize: 12, color: "#1a73e8" }]} numberOfLines={1}>
                          {load.assetName ?? "—"}
                        </Text>
                        <View style={{ paddingHorizontal: 7, paddingVertical: 1, borderRadius: 999, backgroundColor: tint.bg }}>
                          <Text style={[txt(800), { fontSize: 9, color: tint.fg, letterSpacing: 0.3 }]}>
                            {STATUS_LABEL[load.status]}
                          </Text>
                        </View>
                      </View>
                      <Text style={[txt(800), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
                        {load.title}
                      </Text>
                      {pickup || delivery ? (
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, marginTop: 3 }}>
                          <MapPin size={11} color="#5f6368" strokeWidth={2.2} />
                          <Text style={[txt(500), { fontSize: 12, color: "#5f6368", flex: 1 }]} numberOfLines={1}>
                            {locLabel(pickup)} → {locLabel(delivery)}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
