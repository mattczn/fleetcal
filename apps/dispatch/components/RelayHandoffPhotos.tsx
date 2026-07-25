/**
 * Relay handoff photos — dispatch (ops mobile) inline button.
 *
 * Mirrors the web pattern: one small button slotted next to the
 * relay info. State is binary:
 *   - No photos yet → "Upload Handoff Photo" (purple-filled,
 *     opens a file picker and uploads as relay_handoff). Uses
 *     expo-document-picker (no native camera) since ops mostly
 *     uploads photos a driver phoned in, not photos they take.
 *   - 1+ photos    → "View Handoff Photos (N)" (purple-outlined,
 *     calls onViewDocuments so the parent can switch tabs to the
 *     existing Documents viewer).
 *
 * N-leg aware: photos carry DocumentSummary.handoffIndex (0-based marker
 * ordinal — marker i sits between leg i and leg i+1). When the caller
 * passes legIndex/legCount, the count only includes photos relevant to
 * that leg: handoffIndex null (legacy, shown everywhere) or matching the
 * leg's inbound (legIndex-1) / outbound (legIndex) handoff. Uploads tag
 * the photo with the leg's outbound handoff (inbound for the final leg).
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, TouchableOpacity, Text } from "react-native";
import { Upload, Image as ImageIcon } from "lucide-react-native";
import * as DocumentPicker from "expo-document-picker";
import { railway } from "@/lib/railway";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

interface Props {
  loadId: string;
  /** 0-based position of the leg this button renders for. Omit (with
   *  legCount) to count every handoff photo on the load. */
  legIndex?: number;
  /** Total legs on the load. */
  legCount?: number;
  /** Called when the button is in "View Handoff Photos" mode — parent
   *  navigates to its Documents tab. */
  onViewDocuments?: () => void;
}

/** Handoff ordinals adjacent to a leg: inbound = legIndex-1, outbound = legIndex. */
function relevantHandoffs(legIndex: number, legCount: number): number[] {
  const out: number[] = [];
  if (legIndex > 0) out.push(legIndex - 1);            // inbound handoff
  if (legIndex < legCount - 1) out.push(legIndex);      // outbound handoff
  return out;
}

export function HandoffPhotosButton({ loadId, legIndex, legCount, onViewDocuments }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const ordinals = legIndex != null && legCount != null && legCount > 1
    ? relevantHandoffs(legIndex, legCount)
    : null;

  const refresh = useCallback(async () => {
    try {
      const res = await railway.listLoadDocuments(loadId);
      const all = (res.documents ?? []) as Array<{ kind?: string; handoffIndex?: number | null }>;
      setCount(all.filter(d => {
        if (d?.kind !== "relay_handoff") return false;
        if (!ordinals) return true;
        // null/absent handoffIndex = legacy load-level photo → every leg.
        return d.handoffIndex == null || ordinals.includes(d.handoffIndex);
      }).length);
    } catch (err) {
      console.warn("[dispatch handoff photos count]", err);
      setCount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadId, legIndex, legCount]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function uploadFile() {
    setBusy(true);
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["image/*"],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (res.canceled) return;
      const asset = res.assets?.[0];
      if (!asset) return;
      const form = new FormData();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append("file", { uri: asset.uri, name: asset.name ?? `relay-${Date.now()}.jpg`, type: asset.mimeType ?? "image/jpeg" } as any);
      form.append("kind", "relay_handoff");
      // Tag the photo with the handoff it documents: the leg's outbound
      // handoff for non-final legs, inbound for the final leg.
      if (legIndex != null && legCount != null && legCount > 1) {
        const handoffIndex = legIndex < legCount - 1 ? legIndex : legIndex - 1;
        if (handoffIndex >= 0) form.append("handoffIndex", String(handoffIndex));
      }
      await railway.uploadLoadDocument(loadId, form);
      await refresh();
    } catch (err) {
      Alert.alert("Upload failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const hasPhotos = (count ?? 0) > 0;

  return (
    <TouchableOpacity
      onPress={hasPhotos && onViewDocuments ? onViewDocuments : uploadFile}
      activeOpacity={0.8}
      disabled={busy || count === null}
      style={{
        marginTop: 10,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingVertical: 10,
        borderRadius: 10,
        backgroundColor: hasPhotos ? "#ffffff" : "#6b21a8",
        borderWidth: 1,
        borderColor: hasPhotos ? "#ddd6fe" : "transparent",
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? (
        <ActivityIndicator size="small" color={hasPhotos ? "#6b21a8" : "#fff"} />
      ) : hasPhotos ? (
        <ImageIcon size={14} color="#6b21a8" strokeWidth={2.4} />
      ) : (
        <Upload size={14} color="#fff" strokeWidth={2.4} />
      )}
      <Text style={[txt(700), { fontSize: 13, color: hasPhotos ? "#6b21a8" : "#fff", letterSpacing: 0.2 }]}>
        {busy
          ? "Uploading…"
          : count === null
            ? "Loading…"
            : hasPhotos
              ? `View Handoff Photos (${count})`
              : "Upload Handoff Photo"}
      </Text>
    </TouchableOpacity>
  );
}
