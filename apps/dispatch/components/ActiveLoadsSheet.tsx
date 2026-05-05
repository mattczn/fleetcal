import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, SectionList } from "react-native";
import { X, Truck } from "lucide-react-native";
import { txt } from "@/lib/font";
import {
  STATUS_TINT, STATUS_LABEL, showStatusPill, fmtTimeRange, loadNumLabel,
  RelayChip, DiagonalStripes, NonRevChip,
} from "@/lib/loadCard";
import type { Asset, Load } from "@/lib/types";

interface Props {
  visible:    boolean;
  inTransit:  Load[];
  pickupsSoon: Load[];
  justDelivered: Load[];
  /** Asset lookup keyed by assetId, for color + unit number on each row. */
  assetById:  Map<number, Asset>;
  onClose:    () => void;
  onSelect:   (load: Load) => void;
}

export function ActiveLoadsSheet({
  visible, inTransit, pickupsSoon, justDelivered, assetById, onClose, onSelect,
}: Props) {
  const sections = [
    { title: "In Transit",                       data: inTransit },
    { title: "Picks Up Soon (Next 4 Hours)",     data: pickupsSoon },
    { title: "Just Delivered (Past 4 Hours)",    data: justDelivered },
  ].filter((s) => s.data.length > 0);

  const total = inTransit.length + pickupsSoon.length + justDelivered.length;

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
                Today's Loads
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
                In transit, pickups in next 4h, deliveries in last 4h.
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {total === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                Nothing on the clock right now.
              </Text>
            </View>
          ) : (
            <SectionList
              sections={sections}
              keyExtractor={(l) => l.id}
              keyboardShouldPersistTaps="handled"
              stickySectionHeadersEnabled={false}
              renderSectionHeader={({ section: { title } }) => (
                <View style={{
                  paddingHorizontal: 18, paddingTop: 16, paddingBottom: 6,
                  backgroundColor: "#ffffff",
                }}>
                  <Text style={[txt(800), {
                    fontSize: 11, letterSpacing: 0.6, color: "#5f6368",
                    textTransform: "uppercase",
                  }]}>
                    {title}
                  </Text>
                </View>
              )}
              renderItem={({ item: load }) => {
                const tint = STATUS_TINT[load.status];
                const asset = assetById.get(load.assetId);
                const color = asset?.color ?? "#1a73e8";
                const assetLabel = asset
                  ? `${asset.name}${asset.unit ? ` · #${asset.unit}` : ""}`
                  : load.assetName ?? "—";
                const driverLabel = load.driverName?.trim();
                const line2 = driverLabel ? `${assetLabel} · ${driverLabel}` : assetLabel;
                const isNonRev = load.eventKind === "non_revenue";
                return (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => onSelect(load)}
                    style={{
                      flexDirection: "row", alignItems: "center", gap: 12,
                      paddingHorizontal: 18, paddingVertical: 14,
                      borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
                      overflow: "hidden",
                    }}
                  >
                    {isNonRev ? <DiagonalStripes /> : null}
                    <View style={{
                      width: 36, height: 36, borderRadius: 10,
                      backgroundColor: color,
                      alignItems: "center", justifyContent: "center",
                    }}>
                      <Truck size={16} color="#ffffff" strokeWidth={2.2} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <Text style={[txt(800), { fontSize: 14, color: "#202124", flex: 1 }]} numberOfLines={1}>
                          {load.title}
                        </Text>
                        {isNonRev ? <NonRevChip size="small" /> : null}
                        {load.relayRole ? <RelayChip role={load.relayRole} size="small" /> : null}
                      </View>
                      <Text style={[txt(600), { fontSize: 12, color: "#3c4043", marginTop: 2 }]} numberOfLines={1}>
                        {line2}
                      </Text>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 }}>
                        <Text style={[txt(700), { fontSize: 11, color: "#1a73e8" }]} numberOfLines={1}>
                          {loadNumLabel(load)}
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
                      </View>
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
