/**
 * Relay handoff photos — dispatch (ops mobile) inline button.
 *
 * Mirrors the web pattern: one small button slotted next to the
 * relay info. State is binary:
 *   - No photos yet → "Upload Handoff Photo" (purple-filled,
 *     opens the camera/library prompt and uploads as relay_handoff).
 *   - 1+ photos    → "View Handoff Photos (N)" (purple-outlined,
 *     calls onViewDocuments so the parent can switch tabs to the
 *     existing Documents viewer).
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, TouchableOpacity, Text } from "react-native";
import { Camera, Image as ImageIcon } from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
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
  /** Called when the button is in "View Handoff Photos" mode — parent
   *  navigates to its Documents tab. */
  onViewDocuments?: () => void;
}

export function HandoffPhotosButton({ loadId, onViewDocuments }: Props) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await railway.listLoadDocuments(loadId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = (res.documents ?? []) as any[];
      setCount(all.filter(d => d?.kind === "relay_handoff").length);
    } catch (err) {
      console.warn("[dispatch handoff photos count]", err);
      setCount(0);
    }
  }, [loadId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function uploadFrom(source: "camera" | "library") {
    setBusy(true);
    try {
      const perm = source === "camera"
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Enable access in Settings.");
        return;
      }
      const res = source === "camera"
        ? await ImagePicker.launchCameraAsync({ quality: 0.85 })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ImagePicker.MediaTypeOptions.Images,
            quality: 0.85, allowsMultipleSelection: false,
          });
      if (res.canceled) return;
      const a = res.assets[0];
      if (!a) return;
      const form = new FormData();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append("file", { uri: a.uri, name: a.fileName ?? `relay-${Date.now()}.jpg`, type: a.mimeType ?? "image/jpeg" } as any);
      form.append("kind", "relay_handoff");
      await railway.uploadLoadDocument(loadId, form);
      await refresh();
    } catch (err) {
      Alert.alert("Upload failed", (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function promptUpload() {
    Alert.alert(
      "Add Relay Handoff Photo",
      "Trailer location, paperwork — leave it for the relay drivers.",
      [
        { text: "Take Photo",          onPress: () => void uploadFrom("camera") },
        { text: "Choose from Library", onPress: () => void uploadFrom("library") },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  const hasPhotos = (count ?? 0) > 0;

  return (
    <TouchableOpacity
      onPress={hasPhotos && onViewDocuments ? onViewDocuments : promptUpload}
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
        <Camera size={14} color="#fff" strokeWidth={2.4} />
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

