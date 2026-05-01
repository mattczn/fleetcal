import React, { useMemo, useState } from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, FlatList, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Check, X, Box, Search } from "lucide-react-native";
import { fetchTrailers } from "@/lib/api/loads";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

type Props = {
  visible:    boolean;
  orgId:      string;
  currentId?: number;
  onClose:    () => void;
  onSelect:   (trailerId: number | null) => void;
};

export function TrailerPickerSheet({ visible, orgId, currentId, onClose, onSelect }: Props) {
  const { data: trailers, isLoading } = useQuery({
    queryKey: ["trailers", orgId],
    queryFn:  () => fetchTrailers(orgId),
    enabled:  visible,
    staleTime: 10 * 60 * 1000,
  });

  const [query, setQuery] = useState("");

  // Reset the query whenever the sheet closes so it opens clean next time
  React.useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);

  const filtered = useMemo(() => {
    const all = trailers ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => {
      const num = (t.trailerNumber ?? "").toLowerCase();
      const name = t.name.toLowerCase();
      return num.includes(q) || name.includes(q);
    });
  }, [trailers, query]);

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
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: "80%",
            paddingBottom: 28,
            paddingTop: 8,
          }}
        >
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingHorizontal: 18,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: "#f1f3f4",
            }}
          >
            <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
              Select trailer
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>

          {/* Search */}
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 6 }}>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: "#f1f3f4",
                borderRadius: 10,
              }}
            >
              <Search size={16} color="#5f6368" strokeWidth={2.2} />
              <TextInput
                placeholder="Search by trailer number or name"
                placeholderTextColor="#9aa0a6"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
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
          ) : (trailers ?? []).length === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                No trailers configured for this org.
              </Text>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: "#9aa0a6" }]}>
                No trailers match &ldquo;{query}&rdquo;
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(t) => String(t.id)}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const isCurrent = item.id === currentId;
                return (
                  <TouchableOpacity
                    activeOpacity={0.7}
                    onPress={() => onSelect(item.id)}
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 12,
                      paddingHorizontal: 18,
                      paddingVertical: 14,
                      borderBottomWidth: 1,
                      borderBottomColor: "#f1f3f4",
                    }}
                  >
                    <View
                      style={{
                        width: 36, height: 36, borderRadius: 10,
                        backgroundColor: "#e8f0fe",
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Box size={16} color="#1a73e8" strokeWidth={2.2} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[txt(700), { fontSize: 14, color: "#202124" }]}>
                        #{item.trailerNumber ?? item.name}
                      </Text>
                      <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
                        {item.category}
                      </Text>
                    </View>
                    {isCurrent ? <Check size={18} color="#1a73e8" strokeWidth={2.6} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          {currentId != null ? (
            <TouchableOpacity
              onPress={() => onSelect(null)}
              style={{
                marginTop: 8,
                marginHorizontal: 18,
                paddingVertical: 12,
                alignItems: "center",
                backgroundColor: "#fef2f2",
                borderRadius: 10,
                borderWidth: 1, borderColor: "#fecaca",
              }}
            >
              <Text style={[txt(700), { fontSize: 13, color: "#b91c1c" }]}>
                Clear trailer
              </Text>
            </TouchableOpacity>
          ) : null}
        </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
