import React from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, ScrollView,
  Animated, Easing,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Eye, EyeOff, ChevronUp, ChevronDown, X } from "lucide-react-native";
import { txt } from "@/lib/font";
import type { Asset } from "@/lib/types";

interface Props {
  visible:        boolean;
  onClose:        () => void;
  allAssets:      Asset[];
  effectiveOrder: number[];
  hiddenIds:      number[];
  onToggleHidden: (id: number, hidden: boolean) => void;
  onSetAllHidden: (hidden: boolean) => void;
  onMove:         (id: number, dir: "up" | "down") => void;
}

/**
 * Slide-in side drawer (from the left) showing every asset with controls
 * to hide/show and reorder. Persists via the parent's prefs hook.
 */
export function AssetSidePanel({
  visible, onClose,
  allAssets, effectiveOrder, hiddenIds,
  onToggleHidden, onSetAllHidden, onMove,
}: Props) {
  const insets = useSafeAreaInsets();
  const slide = React.useRef(new Animated.Value(-1)).current;

  React.useEffect(() => {
    Animated.timing(slide, {
      toValue:  visible ? 0 : -1,
      duration: 220,
      easing:   Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  const byId = new Map(allAssets.map((a) => [a.id, a]));
  const orderedAssets = effectiveOrder
    .map((id) => byId.get(id))
    .filter((a): a is Asset => !!a);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)" }}>
        <Animated.View
          style={{
            position: "absolute", top: 0, bottom: 0, left: 0,
            width: "82%", maxWidth: 360,
            backgroundColor: "#ffffff",
            transform: [{
              translateX: slide.interpolate({
                inputRange:  [-1, 0],
                outputRange: [-360, 0],
              }),
            }],
            shadowColor: "#000", shadowOpacity: 0.25, shadowRadius: 18, shadowOffset: { width: 4, height: 0 },
          }}
        >
          <Pressable onPress={(e) => e.stopPropagation()} style={{ flex: 1 }}>
            {/* Header */}
            <View style={{
              paddingTop: insets.top + 12,
              paddingHorizontal: 18, paddingBottom: 14,
              borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
            }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={{ flex: 1 }}>
                  <Text style={[txt(800), { fontSize: 18, color: "#202124" }]}>Assets</Text>
                  <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 2 }]}>
                    Toggle and reorder which assets show in the pager.
                  </Text>
                </View>
                <TouchableOpacity onPress={onClose} hitSlop={10}>
                  <X size={20} color="#5f6368" strokeWidth={2.2} />
                </TouchableOpacity>
              </View>

              {/* Bulk-action buttons */}
              <View style={{ flexDirection: "row", gap: 8, marginTop: 12 }}>
                <TouchableOpacity
                  onPress={() => onSetAllHidden(false)}
                  activeOpacity={0.7}
                  style={{
                    flex: 1, paddingVertical: 8, borderRadius: 999,
                    backgroundColor: "#e6f4ea",
                    borderWidth: 1, borderColor: "#bbf7d0",
                    alignItems: "center",
                  }}
                >
                  <Text style={[txt(800), { fontSize: 12, color: "#15803d", letterSpacing: 0.3 }]}>
                    Show all
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onSetAllHidden(true)}
                  activeOpacity={0.7}
                  style={{
                    flex: 1, paddingVertical: 8, borderRadius: 999,
                    backgroundColor: "#f1f3f4",
                    borderWidth: 1, borderColor: "#e8eaed",
                    alignItems: "center",
                  }}
                >
                  <Text style={[txt(800), { fontSize: 12, color: "#3c4043", letterSpacing: 0.3 }]}>
                    Hide all
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <ScrollView contentContainerStyle={{ paddingVertical: 8 }}>
              {orderedAssets.map((a, idx) => {
                const isHidden = hiddenIds.includes(a.id) || a.hidden;
                const tint = a.color ?? "#9aa0a6";
                return (
                  <View
                    key={a.id}
                    style={{
                      flexDirection: "row", alignItems: "center",
                      paddingHorizontal: 18, paddingVertical: 10, gap: 10,
                      opacity: isHidden ? 0.45 : 1,
                    }}
                  >
                    <View style={{ width: 10, height: 28, borderRadius: 3, backgroundColor: tint }} />

                    <View style={{ flex: 1 }}>
                      <Text style={[txt(700), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
                        {a.name}{a.unit ? ` · #${a.unit}` : ""}
                      </Text>
                    </View>

                    {/* Reorder */}
                    <TouchableOpacity
                      onPress={() => onMove(a.id, "up")}
                      disabled={idx === 0}
                      hitSlop={8}
                      style={{
                        width: 30, height: 30, borderRadius: 8,
                        backgroundColor: idx === 0 ? "#f8f9fa" : "#f1f3f4",
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <ChevronUp size={15} color={idx === 0 ? "#dadce0" : "#3c4043"} strokeWidth={2.4} />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onMove(a.id, "down")}
                      disabled={idx === orderedAssets.length - 1}
                      hitSlop={8}
                      style={{
                        width: 30, height: 30, borderRadius: 8,
                        backgroundColor: idx === orderedAssets.length - 1 ? "#f8f9fa" : "#f1f3f4",
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <ChevronDown size={15} color={idx === orderedAssets.length - 1 ? "#dadce0" : "#3c4043"} strokeWidth={2.4} />
                    </TouchableOpacity>

                    {/* Visibility */}
                    <TouchableOpacity
                      onPress={() => onToggleHidden(a.id, !isHidden)}
                      hitSlop={8}
                      style={{
                        width: 36, height: 30, borderRadius: 8,
                        backgroundColor: isHidden ? "#f1f3f4" : "#e6f4ea",
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      {isHidden
                        ? <EyeOff size={15} color="#9aa0a6" strokeWidth={2.4} />
                        : <Eye    size={15} color="#15803d" strokeWidth={2.4} />}
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}
