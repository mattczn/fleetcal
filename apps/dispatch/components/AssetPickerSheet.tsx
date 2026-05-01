import React from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, FlatList } from "react-native";
import { X, Truck } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Asset } from "@/lib/types";

interface Props {
  visible: boolean;
  title:   string;
  hint?:   string;
  assets:  Asset[];
  onClose: () => void;
  onSelect: (asset: Asset) => void;
}

export function AssetPickerSheet({ visible, title, hint, assets, onClose, onSelect }: Props) {
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

          {assets.length === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                No assets in this org.
              </Text>
            </View>
          ) : (
            <FlatList
              data={assets}
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
