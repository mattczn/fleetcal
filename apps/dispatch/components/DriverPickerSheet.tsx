import React, { useMemo, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, FlatList, ActivityIndicator,
  TextInput, KeyboardAvoidingView, Platform,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Check, X, User, Search } from "lucide-react-native";
import { fetchDrivers } from "@/lib/api";
import { txt } from "@/lib/font";

interface Props {
  visible:    boolean;
  orgId:      string;
  currentId?: number;
  onClose:    () => void;
  onSelect:   (driverId: number | null, driverName: string | null) => void;
}

export function DriverPickerSheet({ visible, orgId, currentId, onClose, onSelect }: Props) {
  const { data: drivers, isLoading } = useQuery({
    queryKey: ["drivers", orgId],
    queryFn:  () => fetchDrivers(orgId),
    enabled:  visible && !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const [query, setQuery] = useState("");
  React.useEffect(() => { if (!visible) setQuery(""); }, [visible]);

  const filtered = useMemo(() => {
    const all = drivers ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((d) =>
      d.name.toLowerCase().includes(q) || (d.phone ?? "").toLowerCase().includes(q),
    );
  }, [drivers, query]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={{ flex: 1, justifyContent: "flex-end" }}
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
              <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
                Select driver
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={10}>
                <X size={20} color="#5f6368" strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6 }}>
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 8,
                paddingHorizontal: 12, paddingVertical: 10,
                backgroundColor: "#f1f3f4", borderRadius: 10,
              }}>
                <Search size={16} color="#5f6368" strokeWidth={2.2} />
                <TextInput
                  placeholder="Search by name or phone"
                  placeholderTextColor="#9aa0a6"
                  value={query}
                  onChangeText={setQuery}
                  autoCapitalize="words"
                  autoCorrect={false}
                  clearButtonMode="while-editing"
                  style={[txt(600), { flex: 1, fontSize: 14, color: "#202124", padding: 0 }]}
                />
              </View>
            </View>

            {isLoading ? (
              <View style={{ paddingVertical: 50, alignItems: "center" }}>
                <ActivityIndicator color="#1a73e8" />
              </View>
            ) : filtered.length === 0 ? (
              <View style={{ paddingVertical: 40, alignItems: "center" }}>
                <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                  {query ? `No drivers match "${query}"` : "No drivers configured."}
                </Text>
              </View>
            ) : (
              <FlatList
                data={filtered}
                keyExtractor={(d) => String(d.id)}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item }) => {
                  const isCurrent = item.id === currentId;
                  return (
                    <TouchableOpacity
                      activeOpacity={0.7}
                      onPress={() => onSelect(item.id, item.name)}
                      style={{
                        flexDirection: "row", alignItems: "center", gap: 12,
                        paddingHorizontal: 18, paddingVertical: 14,
                        borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
                      }}
                    >
                      <View style={{
                        width: 36, height: 36, borderRadius: 10,
                        backgroundColor: "#e8f0fe",
                        alignItems: "center", justifyContent: "center",
                      }}>
                        <User size={16} color="#1a73e8" strokeWidth={2.2} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]}>
                          {item.name}
                        </Text>
                        {item.phone ? (
                          <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
                            {item.phone}
                          </Text>
                        ) : null}
                      </View>
                      {isCurrent ? <Check size={18} color="#1a73e8" strokeWidth={2.6} /> : null}
                    </TouchableOpacity>
                  );
                }}
              />
            )}

            {currentId != null ? (
              <TouchableOpacity
                onPress={() => onSelect(null, null)}
                style={{
                  marginTop: 8, marginHorizontal: 18,
                  paddingVertical: 12, alignItems: "center",
                  backgroundColor: "#fef2f2", borderRadius: 10,
                  borderWidth: 1, borderColor: "#fecaca",
                }}
              >
                <Text style={[txt(700), { fontSize: 13, color: "#b91c1c" }]}>
                  Clear driver
                </Text>
              </TouchableOpacity>
            ) : null}
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
