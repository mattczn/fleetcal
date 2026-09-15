import React, { useMemo } from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, FlatList } from "react-native";
import { X, Truck } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Asset } from "@/lib/types";
import { pickableOn } from "@fleetcal/types";
import { todayKeyDeviceLocal } from "@/lib/timezone";

interface Props {
  visible: boolean;
  title:   string;
  hint?:   string;
  assets:  Asset[];
  onClose: () => void;
  onSelect: (asset: Asset) => void;
}

export function AssetPickerSheet({ visible, title, hint, assets, onClose, onSelect }: Props) {
  // THE place equipment gets filtered for "what can I choose".
  //
  // Callers pass whatever list they hold — usually the full roster,
  // because they also need it to resolve names on existing records.
  // Picking is a different question from displaying: offering a truck
  // that left the fleet in May is how a load or work order ends up
  // assigned to equipment that no longer exists. Curzon had three
  // retired units (WS-140692, P-E431985, P- Swap) still selectable
  // here because nothing on the phone read activeTo.
  //
  // Scoped to TODAY, unlike the calendar, which scopes to the day being
  // viewed so history still renders under its own column.
  const pickable = useMemo(
    () => pickableOn(assets, todayKeyDeviceLocal()),
    [assets],
  );
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
              <Text style={[txt(800), { fontSize: 16, color: "#202124" }]}>{title}</Text>
              {hint ? (
                <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
                  {hint}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {pickable.length === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                {assets.length === 0
                  ? "No assets in this org."
                  : "No active trucks."}
              </Text>
            </View>
          ) : (
            <FlatList
              data={pickable}
              keyExtractor={(a) => String(a.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => onSelect(item)}
                  style={{
                    flexDirection: "row", alignItems: "center", gap: 12,
                    paddingHorizontal: 18, paddingVertical: 14,
                    borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
                  }}
                >
                  <View style={{
                    width: 36, height: 36, borderRadius: 10,
                    backgroundColor: item.color ?? "#9aa0a6",
                    alignItems: "center", justifyContent: "center",
                  }}>
                    <Truck size={16} color="#ffffff" strokeWidth={2.2} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[txt(700), { fontSize: 14, color: "#202124" }]}>
                      {item.name}
                    </Text>
                    {item.unit ? (
                      <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
                        Unit #{item.unit}
                      </Text>
                    ) : null}
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
