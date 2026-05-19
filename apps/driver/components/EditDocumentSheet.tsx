import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, Modal, ActivityIndicator, Alert, Pressable, TextInput, ScrollView,
} from "react-native";
import { X, Check } from "lucide-react-native";
import { updateDocument, type DocumentKind, type LoadDocument } from "@/lib/api/documents";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

// Mirrors the kinds the driver UploadSheet used to expose pre-upload,
// plus the dispatcher-only kinds so a driver can still re-categorize
// something the API auto-named (e.g. fix a doc that got marked "other"
// to "rate_con"). Keep aligned with packages/types/api.ts DOCUMENT_KINDS.
const KIND_OPTIONS: { key: DocumentKind; label: string; tint: string }[] = [
  { key: "pod",          label: "POD",      tint: "#15803d" },
  { key: "bol",          label: "BOL",      tint: "#1a73e8" },
  { key: "scale",        label: "Scale",    tint: "#9a3412" },
  { key: "lumper",       label: "Lumper",   tint: "#92400e" },
  { key: "receipt",      label: "Receipt",  tint: "#9d174d" },
  { key: "rate_con",     label: "Rate Con", tint: "#92400e" },
  { key: "driver_sheet", label: "Sheet",    tint: "#6d28d9" },
  { key: "other",        label: "Other",    tint: "#5f6368" },
];

interface Props {
  doc:        LoadDocument | null;
  /** Title above the form. "Categorize document" right after an upload,
   *  "Edit document" when launched from the documents list. */
  mode:       "categorize" | "edit";
  visible:    boolean;
  onClose:    () => void;
  /** Called after a successful PATCH. Caller decides what to do (typically
   *  refetch the documents query). */
  onUpdated:  () => void;
}

export function EditDocumentSheet({ doc, mode, visible, onClose, onUpdated }: Props) {
  const [kind, setKind] = useState<DocumentKind>("other");
  const [fileName, setFileName] = useState("");
  const [saving, setSaving] = useState(false);

  // Reset form whenever the modal opens with a new doc — without this,
  // changing kind on one doc then opening another shows the previous
  // selection until you tap something.
  useEffect(() => {
    if (visible && doc) {
      setKind(doc.kind);
      setFileName(doc.fileName);
    }
  }, [visible, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null;

  async function handleSave() {
    if (!doc) return;
    const trimmed = fileName.trim();
    if (!trimmed) {
      Alert.alert("Name required", "Please enter a name for this document.");
      return;
    }
    const patch: { fileName?: string; kind?: DocumentKind } = {};
    if (trimmed !== doc.fileName) patch.fileName = trimmed;
    if (kind !== doc.kind)        patch.kind = kind;
    // Nothing changed → just close, no network call.
    if (!patch.fileName && !patch.kind) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await updateDocument(doc.id, patch);
      onUpdated();
      onClose();
    } catch (err) {
      Alert.alert("Couldn't save", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  const title = mode === "categorize" ? "Categorize document" : "Edit document";
  const subtitle = mode === "categorize"
    ? "Pick a type for this upload. You can edit later if needed."
    : "Change the type or rename this document.";

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <Pressable onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28,
            maxHeight: "85%",
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#e8eaed", alignSelf: "center", marginBottom: 14 }} />

          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
            <Text style={[txt(800), { fontSize: 18, color: "#202124", flex: 1 }]}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} disabled={saving}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <Text style={[txt(500), { fontSize: 13, color: "#5f6368", marginBottom: 16 }]}>
            {subtitle}
          </Text>

          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
            <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
              Document type
            </Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
              {KIND_OPTIONS.map((opt) => {
                const active = kind === opt.key;
                return (
                  <TouchableOpacity key={opt.key} onPress={() => setKind(opt.key)} activeOpacity={0.7}
                    disabled={saving}
                    style={{
                      paddingVertical: 9,
                      paddingHorizontal: 12,
                      borderRadius: 10,
                      backgroundColor: active ? `${opt.tint}15` : "#f8f9fa",
                      borderWidth: 1.5,
                      borderColor: active ? opt.tint : "#e8eaed",
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {active ? <Check size={12} color={opt.tint} strokeWidth={2.6} /> : null}
                    <Text style={[txt(800), { fontSize: 12, color: active ? opt.tint : "#5f6368", letterSpacing: 0.3 }]}>
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
              File name
            </Text>
            <TextInput
              value={fileName}
              onChangeText={setFileName}
              editable={!saving}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                borderWidth: 1,
                borderColor: "#e8eaed",
                borderRadius: 10,
                paddingVertical: 12,
                paddingHorizontal: 14,
                fontSize: 14,
                color: "#202124",
                marginBottom: 18,
                backgroundColor: "#ffffff",
                ...txt(600),
              }}
            />
          </ScrollView>

          <TouchableOpacity
            onPress={handleSave}
            disabled={saving}
            activeOpacity={0.85}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: "#1a73e8",
              opacity: saving ? 0.6 : 1,
              shadowColor: "#1a73e8", shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
            }}
          >
            {saving ? <ActivityIndicator color="#ffffff" /> : <Check size={16} color="#ffffff" strokeWidth={2.6} />}
            <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
              {saving ? "Saving…" : "Save"}
            </Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
