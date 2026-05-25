/**
 * Relay handoff photos.
 *
 * Pickup driver leaves photos for the delivery driver — typically
 * "where the trailer is parked" + paperwork shots in case the
 * physical copies get lost. Lives on the load, scoped via
 * `kind='relay_handoff'`. Both legs see + can add to the same set.
 */
import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, Image, Alert, ActivityIndicator, Modal, ScrollView,
} from "react-native";
import { Camera, Plus, X, Trash2 } from "lucide-react-native";
import * as ImagePicker from "expo-image-picker";
import { railway } from "@/lib/railway";
import { normalizeImageForUpload } from "@/lib/imageNormalize";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

// API returns documents as unknown[]; we narrow to the shape we
// actually consume here so we don't have to re-import the LoadDocument
// type from a different module.
interface DocLike {
  id: string;
  kind: string;
  fileName: string;
  uploadedAt: string;
  signedUrl?: string;
}

/**
 * Shared upload flow — exposed so the stop-card button below the
 * Navigate / Check In row can reuse the exact same camera/library
 * prompt without duplicating the picker glue.
 */
export async function uploadRelayHandoffPhoto(loadId: string, source: "camera" | "library"): Promise<void> {
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
  // Force-transcode to real JPEG — iPhone HEIC photos otherwise lie
  // about their mime/extension and aren't renderable downstream.
  const norm = await normalizeImageForUpload(a.uri, a.fileName ?? `relay-${Date.now()}.jpg`);
  const form = new FormData();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  form.append("file", { uri: norm.uri, name: norm.fileName, type: norm.mimeType } as any);
  form.append("kind", "relay_handoff");
  await railway.uploadDocument(loadId, form);
}

export function promptRelayHandoffUpload(loadId: string, onUploaded?: () => void) {
  Alert.alert(
    "Add Relay Handoff Photo",
    "Trailer location, paperwork — leave it for the next driver.",
    [
      { text: "Take Photo",          onPress: async () => { try { await uploadRelayHandoffPhoto(loadId, "camera");  onUploaded?.(); } catch (err) { Alert.alert("Upload failed", (err as Error).message); } } },
      { text: "Choose from Library", onPress: async () => { try { await uploadRelayHandoffPhoto(loadId, "library"); onUploaded?.(); } catch (err) { Alert.alert("Upload failed", (err as Error).message); } } },
      { text: "Cancel", style: "cancel" },
    ],
    { cancelable: true },
  );
}

export function RelayHandoffPhotos({ loadId, reloadKey }: { loadId: string; reloadKey?: number }) {
  const [photos,   setPhotos]   = useState<DocLike[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [busy,     setBusy]     = useState(false);
  const [preview,  setPreview]  = useState<DocLike | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await railway.listDocuments(loadId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = (res.documents ?? []) as any[];
      const relay = all
        .filter(d => d?.kind === 'relay_handoff')
        // Newest first — pickup driver's "where I left it" should
        // outrank an earlier doc if both exist.
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
      setPhotos(relay as DocLike[]);
    } catch (err) {
      console.warn('[relay photos] list:', err);
    } finally {
      setLoading(false);
    }
  }, [loadId]);

  useEffect(() => { void refresh(); }, [refresh, reloadKey]);

  function addPhoto() {
    if (busy) return;
    // We can't reliably detect Alert.alert dismissal, so we don't toggle
    // busy on the prompt itself — just on the actual upload, via inline
    // wrappers so the spinner shows while the file is going up.
    Alert.alert(
      "Add Relay Handoff Photo",
      "Trailer location, paperwork — leave it for the next driver.",
      [
        { text: "Take Photo",          onPress: async () => { setBusy(true);  try { await uploadRelayHandoffPhoto(loadId, "camera");  await refresh(); } catch (err) { Alert.alert("Upload failed", (err as Error).message); } finally { setBusy(false); } } },
        { text: "Choose from Library", onPress: async () => { setBusy(true);  try { await uploadRelayHandoffPhoto(loadId, "library"); await refresh(); } catch (err) { Alert.alert("Upload failed", (err as Error).message); } finally { setBusy(false); } } },
        { text: "Cancel", style: "cancel" },
      ],
      { cancelable: true },
    );
  }

  async function deletePhoto(d: DocLike) {
    Alert.alert(
      "Delete photo",
      "Remove this handoff photo?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: async () => {
            try { await railway.deleteDocument(d.id); await refresh(); }
            catch (err) { Alert.alert("Delete failed", (err as Error).message); }
          } },
      ],
    );
  }

  return (
    <View style={{ marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: "#ddd6fe" }}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 8 }}>
        <Text style={[txt(800), { flex: 1, fontSize: 12, color: "#6b21a8", letterSpacing: 0.4, textTransform: "uppercase" }]}>
          Handoff Photos{photos.length > 0 ? ` · ${photos.length}` : ''}
        </Text>
        <TouchableOpacity onPress={addPhoto} disabled={busy}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", gap: 4,
            paddingHorizontal: 10, paddingVertical: 5,
            borderRadius: 8,
            backgroundColor: "#6b21a8",
            opacity: busy ? 0.6 : 1,
          }}>
          {busy
            ? <ActivityIndicator size="small" color="#fff" />
            : <Plus size={12} color="#fff" strokeWidth={2.6} />}
          <Text style={[txt(700), { fontSize: 11, color: "#fff", letterSpacing: 0.2 }]}>Add</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ paddingVertical: 12, alignItems: "center" }}>
          <ActivityIndicator size="small" color="#6b21a8" />
        </View>
      ) : photos.length === 0 ? (
        <TouchableOpacity onPress={addPhoto}
          activeOpacity={0.7}
          style={{
            flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
            paddingVertical: 14,
            borderRadius: 10,
            borderWidth: 1.5, borderColor: "#8b5cf6", borderStyle: "dashed",
            backgroundColor: "#faf5ff",
          }}>
          <Camera size={16} color="#6b21a8" strokeWidth={2.2} />
          <Text style={[txt(700), { fontSize: 13, color: "#6b21a8" }]}>
            Add the first handoff photo
          </Text>
        </TouchableOpacity>
      ) : (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {photos.map(p => (
            <TouchableOpacity key={p.id}
              onPress={() => setPreview(p)}
              activeOpacity={0.85}
              style={{
                width: 76, height: 76, borderRadius: 8,
                overflow: "hidden", position: "relative",
                backgroundColor: "#f1f3f4",
              }}>
              {p.signedUrl ? (
                <Image source={{ uri: p.signedUrl }} style={{ width: "100%", height: "100%" }} />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <Text style={[txt(700), { fontSize: 9, color: "#9aa0a6" }]}>No URL</Text>
                </View>
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Full-screen preview with delete option. Image fills the
       *  available area at its intrinsic aspect ratio (no forced
       *  square) with pinch-zoom up to 3x. Removed the "Open" button
       *  that punted to a Supabase URL — viewing inline here is the
       *  whole point. */}
      {preview && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPreview(null)}>
          <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)" }}>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 16 }}
              maximumZoomScale={3}
              minimumZoomScale={1}>
              {preview.signedUrl
                ? <Image source={{ uri: preview.signedUrl }} style={{ width: "100%", height: "100%", resizeMode: "contain" }} />
                : <Text style={[txt(600), { color: "#fff", textAlign: "center" }]}>Image not available</Text>}
            </ScrollView>
            <View style={{ position: "absolute", top: 50, left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Text style={[txt(500), { fontSize: 12, color: "rgba(255,255,255,0.75)", flex: 1 }]} numberOfLines={1}>
                {preview.fileName}
              </Text>
              <TouchableOpacity onPress={() => setPreview(null)}
                style={{ padding: 10, borderRadius: 22, backgroundColor: "rgba(255,255,255,0.15)", marginLeft: 12 }}>
                <X size={22} color="#fff" strokeWidth={2.4} />
              </TouchableOpacity>
            </View>
            <View style={{ position: "absolute", bottom: 50, left: 16, right: 16, flexDirection: "row", justifyContent: "flex-end" }}>
              <TouchableOpacity
                onPress={() => { const p = preview; setPreview(null); void deletePhoto(p); }}
                style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: "rgba(255,255,255,0.18)", flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Trash2 size={14} color="#fff" />
                <Text style={[txt(700), { fontSize: 13, color: "#fff" }]}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>
      )}
    </View>
  );
}
