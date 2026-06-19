/**
 * Per-row kind editor for the driver app's documents list.
 *
 * Scope: kind ONLY. Filename is server-controlled (auto-named as
 * {LOAD_NUM}_{KIND}.{ext} on upload, and re-deriving it on a kind
 * change would mean a storage rename — out of scope here). The
 * kind picker is filtered to the org's driver-allowed kinds, the
 * same list used by UploadSheet; the server rejects forbidden
 * kinds even if a tampered client sends one.
 */
import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, Modal, ActivityIndicator, Alert, Pressable,
} from "react-native";
import { useQuery } from "@tanstack/react-query";
import { X, Check } from "lucide-react-native";
import { updateDocumentKind, type DocumentKind, type LoadDocument } from "@/lib/api/documents";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { useTheme } from "@/lib/ThemeProvider";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

function kindPresets(C: ReturnType<typeof useTheme>["C"]): Record<DocumentKind, { label: string; tint: string }> {
  return {
    pod:           { label: "POD",      tint: C.greenInk },
    bol:           { label: "BOL",      tint: C.blue },
    scale:         { label: "Scale",    tint: C.amberInk },
    lumper:        { label: "Lumper",   tint: C.amberInk },
    receipt:       { label: "Receipt",  tint: C.redInk },
    driver_sheet:  { label: "Sheet",    tint: C.purple },
    relay_handoff: { label: "Handoff",  tint: C.purple },
    other:         { label: "Other",    tint: C.t3 },
    rate_con:      { label: "Rate Con", tint: C.amberInk },
    invoice:       { label: "Invoice",  tint: C.redInk },
  };
}

interface Props {
  doc:       LoadDocument | null;
  orgId:     string;
  visible:   boolean;
  onClose:   () => void;
  onUpdated: () => void;
}

export function EditDocumentKindSheet({ doc, orgId, visible, onClose, onUpdated }: Props) {
  const { C, SHADOW, ACCENT } = useTheme();
  const KIND_PRESETS = kindPresets(C);
  // Allowed kinds come from /v1/driver/org-settings — same source as
  // UploadSheet so the picker shape is consistent across upload + edit.
  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn:  () => fetchOrgSettings(orgId),
    staleTime: 5 * 60 * 1000,
  });
  const allowedKinds: DocumentKind[] = (
    orgSettings?.driverUploadKinds ?? ["pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "relay_handoff", "other"]
  ).filter((k): k is DocumentKind => k in KIND_PRESETS && k !== "rate_con" && k !== "invoice");

  const [kind, setKind] = useState<DocumentKind>("other");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Initialize the picker to the doc's current kind on open. If the
    // doc's existing kind isn't in the allowed list (rare — historical
    // bad data), default to the first allowed kind so the picker isn't
    // stuck on an option it can't render.
    if (visible && doc) {
      setKind(allowedKinds.includes(doc.kind) ? doc.kind : (allowedKinds[0] ?? "other"));
    }
  }, [visible, doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) return null;

  async function save() {
    if (!doc) return;
    if (kind === doc.kind) { onClose(); return; }
    setSaving(true);
    try {
      await updateDocumentKind(doc.id, kind);
      onUpdated();
      onClose();
    } catch (err) {
      Alert.alert("Couldn't update", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: C.surface,
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28,
          }}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: C.border, alignSelf: "center", marginBottom: 14 }} />

          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
            <Text style={[txt(800), { fontSize: 18, color: C.t1, flex: 1 }]}>Change document type</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} disabled={saving}>
              <X size={20} color={C.t3} strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <Text style={[txt(500), { fontSize: 13, color: C.t3, marginBottom: 16 }]} numberOfLines={1}>
            {doc.fileName}
          </Text>

          <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: C.t3, textTransform: "uppercase", marginBottom: 8 }]}>
            Document type
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            {allowedKinds.map((k) => {
              const preset = KIND_PRESETS[k];
              const active = kind === k;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setKind(k)}
                  activeOpacity={0.7}
                  disabled={saving}
                  style={{
                    paddingVertical: 9,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: active ? `${preset.tint}15` : C.bg,
                    borderWidth: 1.5,
                    borderColor: active ? preset.tint : C.border,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {active ? <Check size={12} color={preset.tint} strokeWidth={2.6} /> : null}
                  <Text style={[txt(800), { fontSize: 12, color: active ? preset.tint : C.t3, letterSpacing: 0.3 }]}>
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <TouchableOpacity
            onPress={() => void save()}
            disabled={saving || kind === doc.kind}
            activeOpacity={0.85}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingVertical: 14,
              borderRadius: 12,
              backgroundColor: ACCENT,
              opacity: saving || kind === doc.kind ? 0.5 : 1,
              shadowColor: ACCENT, shadowOpacity: 0.3, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
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
