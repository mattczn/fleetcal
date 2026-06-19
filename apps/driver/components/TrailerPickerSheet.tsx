import React, { useMemo, useState } from "react";
import { Modal, View, Text, TouchableOpacity, Pressable, FlatList, ActivityIndicator, TextInput, KeyboardAvoidingView, Platform } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { Check, X, Container, Search } from "lucide-react-native";
import { fetchTrailers } from "@/lib/api/loads";
import { useTheme } from "@/lib/ThemeProvider";

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
  /** Optional header text. Defaults to "Select trailer". Used by the
   *  Start Trip prompt to ask "What trailer are you pulling?" */
  title?:     string;
  /** When defined, replaces the standalone "Clear trailer" footer
   *  with a neutral "Continue without trailer" button that fires
   *  this callback instead of clearing. Lets the Start Trip prompt
   *  proceed even when the driver doesn't want to set a trailer. */
  onSkip?:    () => void;
};

export function TrailerPickerSheet({ visible, orgId, currentId, onClose, onSelect, title, onSkip }: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  const { data: trailers, isLoading, isError, refetch } = useQuery({
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
            backgroundColor: C.surface,
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
              borderBottomColor: C.borderSoft,
            }}
          >
            <Text style={[txt(800), { fontSize: 16, color: C.t1, flex: 1 }]}>
              {title ?? "Select trailer"}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color={C.t3} strokeWidth={2.2} />
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
                backgroundColor: C.borderSoft,
                borderRadius: 10,
              }}
            >
              <Search size={16} color={C.t3} strokeWidth={2.2} />
              <TextInput
                placeholder="Search by trailer number or name"
                placeholderTextColor={C.t4}
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                clearButtonMode="while-editing"
                style={[txt(600), { flex: 1, fontSize: 14, color: C.t1, padding: 0 }]}
              />
            </View>
          </View>

          {isLoading ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <ActivityIndicator color={ACCENT} />
            </View>
          ) : isError ? (
            // Fetch failed (network blip mid-drive, server hiccup, etc).
            // Without this branch the picker collapses to the "No
            // trailers configured" message — wrong and misleading.
            <View style={{ paddingVertical: 30, paddingHorizontal: 24, alignItems: "center" }}>
              <Text style={[txt(700), { fontSize: 14, color: C.redInk, marginBottom: 6, textAlign: "center" }]}>
                Could not load trailers
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: C.t3, textAlign: "center", marginBottom: 14 }]}>
                Check your connection and try again. {onSkip ? "Or continue without a trailer." : ""}
              </Text>
              <TouchableOpacity
                onPress={() => void refetch()}
                style={{ backgroundColor: ACCENT, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 8 }}
              >
                <Text style={[txt(700), { color: "#fff", fontSize: 13 }]}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (trailers ?? []).length === 0 ? (
            <View style={{ paddingVertical: 50, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: C.t4 }]}>
                No trailers configured for this org.
              </Text>
            </View>
          ) : filtered.length === 0 ? (
            <View style={{ paddingVertical: 40, alignItems: "center" }}>
              <Text style={[txt(600), { fontSize: 13, color: C.t4 }]}>
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
                      borderBottomColor: C.borderSoft,
                    }}
                  >
                    <View
                      style={{
                        width: 36, height: 36, borderRadius: 10,
                        backgroundColor: C.blueBg,
                        alignItems: "center", justifyContent: "center",
                      }}
                    >
                      <Container size={16} color={ACCENT} strokeWidth={2.2} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[txt(700), { fontSize: 14, color: C.t1 }]}>
                        #{item.trailerNumber ?? item.name}
                      </Text>
                      <Text style={[txt(500), { fontSize: 12, color: C.t3, marginTop: 1 }]}>
                        {item.category}
                      </Text>
                    </View>
                    {isCurrent ? <Check size={18} color={ACCENT} strokeWidth={2.6} /> : null}
                  </TouchableOpacity>
                );
              }}
            />
          )}

          {onSkip ? (
            <TouchableOpacity
              onPress={onSkip}
              style={{
                marginTop: 8,
                marginHorizontal: 18,
                paddingVertical: 12,
                alignItems: "center",
                backgroundColor: C.borderSoft,
                borderRadius: 10,
                borderWidth: 1, borderColor: C.borderStrong,
              }}
            >
              <Text style={[txt(700), { fontSize: 13, color: C.t2 }]}>
                Continue without trailer
              </Text>
            </TouchableOpacity>
          ) : currentId != null ? (
            <TouchableOpacity
              onPress={() => onSelect(null)}
              style={{
                marginTop: 8,
                marginHorizontal: 18,
                paddingVertical: 12,
                alignItems: "center",
                backgroundColor: C.redBg,
                borderRadius: 10,
                borderWidth: 1, borderColor: C.redBg,
              }}
            >
              <Text style={[txt(700), { fontSize: 13, color: C.redInk }]}>
                Clear trailer
              </Text>
            </TouchableOpacity>
          ) : (
            // Fallback footer — always give the driver a clearly
            // labelled exit so the sheet doesn't feel like a dead end
            // when the list is empty or errored. The header X also
            // closes but it's a small target on cab-mounted phones.
            <TouchableOpacity
              onPress={onClose}
              style={{
                marginTop: 8,
                marginHorizontal: 18,
                paddingVertical: 12,
                alignItems: "center",
                backgroundColor: C.borderSoft,
                borderRadius: 10,
                borderWidth: 1, borderColor: C.borderStrong,
              }}
            >
              <Text style={[txt(700), { fontSize: 13, color: C.t2 }]}>
                Close
              </Text>
            </TouchableOpacity>
          )}
        </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
