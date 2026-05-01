import React, { useEffect, useRef, useState } from "react";
import {
  Modal, View, Text, TouchableOpacity, Pressable, TextInput,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from "react-native";
import { X } from "lucide-react-native";
import { txt } from "@/lib/font";

export type EditFieldKind = "text" | "number" | "multiline";

interface Props {
  visible:     boolean;
  title:       string;
  hint?:       string;
  initial:     string;
  kind?:       EditFieldKind;
  placeholder?: string;
  saving?:     boolean;
  onClose:     () => void;
  onSave:      (value: string) => void;
}

export function EditFieldSheet({
  visible, title, hint, initial, kind = "text", placeholder, saving, onClose, onSave,
}: Props) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (visible) {
      setValue(initial);
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [visible, initial]);

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
            }}
          >
            <View style={{
              flexDirection: "row", alignItems: "center",
              paddingHorizontal: 18, paddingVertical: 14,
              borderBottomWidth: 1, borderBottomColor: "#f1f3f4",
            }}>
              <View style={{ flex: 1 }}>
                <Text style={[txt(800), { fontSize: 16, color: "#202124" }]}>
                  Edit {title}
                </Text>
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

            <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 }}>
              <TextInput
                ref={inputRef}
                value={value}
                onChangeText={setValue}
                placeholder={placeholder}
                placeholderTextColor="#9aa0a6"
                multiline={kind === "multiline"}
                keyboardType={kind === "number" ? "decimal-pad" : "default"}
                autoCapitalize={kind === "text" ? "sentences" : "none"}
                autoCorrect={kind === "text"}
                returnKeyType={kind === "multiline" ? "default" : "done"}
                onSubmitEditing={() => {
                  if (kind !== "multiline" && dirty) onSave(value);
                }}
                style={[txt(600), {
                  fontSize: 15, color: "#202124",
                  backgroundColor: "#f1f3f4",
                  borderRadius: 12,
                  paddingHorizontal: 14, paddingVertical: 12,
                  minHeight: kind === "multiline" ? 100 : 0,
                  textAlignVertical: kind === "multiline" ? "top" : "center",
                }]}
              />
            </View>

            <View style={{
              flexDirection: "row", gap: 10,
              paddingHorizontal: 18, paddingBottom: 6,
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
                <Text style={[txt(800), { fontSize: 14, color: "#3c4043" }]}>
                  Cancel
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => onSave(value)}
                activeOpacity={dirty && !saving ? 0.85 : 1}
                disabled={!dirty || saving}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 14,
                  backgroundColor: dirty && !saving ? "#1a73e8" : "#bfdbfe",
                  alignItems: "center",
                }}
              >
                {saving ? (
                  <ActivityIndicator color="#ffffff" />
                ) : (
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
