import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, TextInput, FlatList,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { X, Building2, Check } from "lucide-react-native";
import { fetchCustomers, type Customer } from "@/lib/api";
import { txt } from "@/lib/font";

interface Props {
  visible:  boolean;
  orgId:    string;
  initial:  string;
  saving?:  boolean;
  onClose:  () => void;
  onSave:   (broker: string) => void;
}

function matchesCustomer(query: string, customer: Customer): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (customer.name.toLowerCase().includes(q)) return true;
  if ((customer.shortName ?? "").toLowerCase().includes(q)) return true;
  return customer.aliases.some((a) => a.toLowerCase().includes(q));
}

function exactMatch(query: string, customer: Customer): boolean {
  const q = query.trim().toLowerCase();
  if (q === customer.name.toLowerCase()) return true;
  if ((customer.shortName ?? "").toLowerCase() === q) return true;
  return customer.aliases.some((a) => a.toLowerCase() === q);
}

export function BrokerEditSheet({ visible, orgId, initial, saving, onClose, onSave }: Props) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setValue(initial);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [visible, initial]);

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ["customers", orgId],
    queryFn:  () => fetchCustomers(orgId),
    enabled:  visible && !!orgId,
    staleTime: 10 * 60 * 1000,
  });

  const linked = useMemo(
    () => customers.find((c) => exactMatch(value, c)),
    [customers, value],
  );

  const suggestions = useMemo(() => {
    if (!value.trim()) return [];
    if (linked) return []; // already exact — no need to suggest
    return customers.filter((c) => matchesCustomer(value, c)).slice(0, 8);
  }, [customers, value, linked]);

  const dirty = value !== initial;

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
              paddingBottom: 28, paddingTop: 8,
              maxHeight: "85%",
            }}
          >
            <View style={{
              flexDirection: "row", alignItems: "center",
              paddingHorizontal: 18, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
            }}>
              <Text style={[txt(800), { fontSize: 16, color: "#202124", flex: 1 }]}>
                Edit Customer
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={10}>
                <X size={20} color="#5f6368" strokeWidth={2.2} />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 18, paddingTop: 14, paddingBottom: 8 }}>
              <View style={{
                flexDirection: "row", alignItems: "center", gap: 8,
                paddingHorizontal: 14, paddingVertical: 12,
                backgroundColor: "#f1f3f4", borderRadius: 12,
              }}>
                <Building2 size={16} color="#5f6368" strokeWidth={2.2} />
                <TextInput
                  ref={inputRef}
                  value={value}
                  onChangeText={setValue}
                  placeholder="Customer name"
                  placeholderTextColor="#9aa0a6"
                  autoCapitalize="words"
                  autoCorrect={false}
                  style={[txt(600), { flex: 1, fontSize: 15, color: "#202124", padding: 0 }]}
                />
              </View>

              {linked ? (
                <View style={{
                  flexDirection: "row", alignItems: "center", gap: 6,
                  paddingHorizontal: 12, paddingVertical: 8,
                  backgroundColor: "#e6f4ea", borderRadius: 10,
                  borderWidth: 1, borderColor: "#bbf7d0",
                  marginTop: 8,
                }}>
                  <Check size={13} color="#15803d" strokeWidth={2.6} />
                  <Text style={[txt(700), { fontSize: 12, color: "#15803d", flex: 1 }]} numberOfLines={1}>
                    Linked to {linked.name}
                  </Text>
                </View>
              ) : isLoading ? null : value.trim() && suggestions.length === 0 ? (
                <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 8 }]}>
                  No matching customer — will save as plain text.
                </Text>
              ) : null}
            </View>

            {suggestions.length > 0 ? (
              <View style={{ paddingHorizontal: 18, paddingBottom: 6 }}>
                <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
                  Suggestions
                </Text>
                <FlatList
                  data={suggestions}
                  keyExtractor={(c) => c.id}
                  keyboardShouldPersistTaps="handled"
                  scrollEnabled={false}
                  renderItem={({ item }) => (
                    <TouchableOpacity
                      onPress={() => setValue(item.name)}
                      activeOpacity={0.7}
                      style={{
                        flexDirection: "row", alignItems: "center", gap: 10,
                        paddingVertical: 10,
                        borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
                      }}
                    >
                      <View style={{
                        width: 32, height: 32, borderRadius: 10,
                        backgroundColor: "#e8f0fe",
                        alignItems: "center", justifyContent: "center",
                      }}>
                        <Building2 size={14} color="#1a73e8" strokeWidth={2.2} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]}>
                          {item.name}
                        </Text>
                        {item.aliases.length > 0 ? (
                          <Text style={[txt(500), { fontSize: 11, color: "#9aa0a6", marginTop: 1 }]}>
                            aka {item.aliases.join(", ")}
                          </Text>
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  )}
                />
              </View>
            ) : null}

            <View style={{
              flexDirection: "row", gap: 10,
              paddingHorizontal: 18, paddingTop: 12,
            }}>
              <TouchableOpacity
                onPress={onClose}
                activeOpacity={0.7}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: "#f1f3f4",
                  alignItems: "center",
                }}
              >
                <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onSave(value.trim())}
                activeOpacity={dirty && !saving ? 0.85 : 1}
                disabled={!dirty || saving}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: dirty && !saving ? "#1a73e8" : "#bfdbfe",
                  alignItems: "center",
                }}
              >
                {saving ? <ActivityIndicator color="#ffffff" /> : (
                  <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
                    Save
                  </Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </KeyboardAvoidingView>
      </Pressable>
    </Modal>
  );
}
