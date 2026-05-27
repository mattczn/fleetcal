import React, { useEffect, useState } from "react";
import {
  View, Text, TouchableOpacity, Modal, ActivityIndicator, Alert, Pressable,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import * as Print from "expo-print";
import * as FileSystem from "expo-file-system/legacy";
import * as ImageManipulator from "expo-image-manipulator";
import DocumentScanner from "react-native-document-scanner-plugin";
import { ScanLine, Camera, Image as ImageIcon, FileText, X, Check, Layers } from "lucide-react-native";
import { uploadDocument, type DocumentKind } from "@/lib/api/documents";
import { fetchOrgSettings } from "@/lib/api/orgSettings";
import { enqueueUpload } from "@/lib/uploadQueue";
import { useOnline } from "@/lib/useOnline";
import { useQuery } from "@tanstack/react-query";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

type Props = {
  eventId:    string;
  loadNum?:   string;
  orgId:      string;
  driverId:   number;
  driverName?: string;
  visible:    boolean;
  onClose:    () => void;
  /** Fires after a successful upload (live or queued). The sheet has
   *  already auto-named the file by document type, so the caller's
   *  job is just to refresh the docs list. */
  onUploaded: () => void;
};

const MAX_TOTAL_BYTES = 3 * 1024 * 1024; // 3 MB final upload cap

async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && "size" in info ? (info.size ?? 0) : 0;
}

/**
 * Compress an image to fit under `targetBytes`.
 * Resizes to `maxWidth` first, then steps quality down until small enough.
 * Always re-encodes to JPEG — smaller than HEIC/PNG for photos.
 */
async function compressImage(
  uri: string,
  opts: { targetBytes: number; maxWidth: number; force?: boolean } = {
    targetBytes: MAX_TOTAL_BYTES, maxWidth: 2000,
  },
): Promise<{ uri: string; mimeType: string }> {
  if (!opts.force) {
    const initial = await fileSize(uri);
    if (initial > 0 && initial <= opts.targetBytes) {
      return { uri, mimeType: "image/jpeg" };
    }
  }
  const qualities = [0.7, 0.55, 0.4, 0.3, 0.2];
  let result = uri;
  for (const q of qualities) {
    const out = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: opts.maxWidth } }],
      { compress: q, format: ImageManipulator.SaveFormat.JPEG },
    );
    result = out.uri;
    const size = await fileSize(result);
    if (size > 0 && size <= opts.targetBytes) break;
  }
  return { uri: result, mimeType: "image/jpeg" };
}

/** Compress an image bound for a multi-page PDF — divides the 3MB cap by page count. */
async function compressForPdfPage(uri: string, pageCount: number): Promise<{ uri: string; mimeType: string }> {
  const perPageBytes = Math.max(Math.floor(MAX_TOTAL_BYTES / Math.max(pageCount, 1)) - 50_000, 200_000);
  return compressImage(uri, { targetBytes: perPageBytes, maxWidth: 1600, force: true });
}

function buildFileName(kind: DocumentKind, loadNum: string | undefined, suffix: string, ext: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");
  // Filename is just for display — storage path adds its own uniqueness, so we
  // keep the visible name short. Optional suffix is only used when it adds info
  // beyond the kind (e.g. carrying a Files-app filename forward).
  const parts = [kind.toUpperCase(), loadNum ? safe(loadNum) : "", suffix && safe(suffix)].filter(Boolean);
  return `${parts.join("_")}.${ext}`;
}

type Step = "idle" | "scanning" | "converting" | "uploading";

// Per-kind label + accent — these are the kinds drivers may upload.
// rate_con and invoice are intentionally absent (dispatcher-only). The
// runtime list passed to the picker is filtered further by the org's
// document_types config (Settings → Documents).
const KIND_PRESETS: Record<DocumentKind, { label: string; tint: string }> = {
  pod:           { label: "POD",     tint: "#15803d" },
  bol:           { label: "BOL",     tint: "#1a73e8" },
  scale:         { label: "Scale",   tint: "#9a3412" },
  lumper:        { label: "Lumper",  tint: "#92400e" },
  receipt:       { label: "Receipt", tint: "#9d174d" },
  driver_sheet:  { label: "Sheet",   tint: "#6d28d9" },
  relay_handoff: { label: "Handoff", tint: "#8b5cf6" },
  other:         { label: "Other",   tint: "#5f6368" },
  // Listed for type-completeness only. Filtered out before render.
  rate_con:      { label: "Rate Con", tint: "#92400e" },
  invoice:       { label: "Invoice",  tint: "#9d174d" },
};

export function UploadSheet({ eventId, loadNum, orgId, driverId, driverName, visible, onClose, onUploaded }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const online = useOnline();

  // Fetch the org's allowed driver upload kinds. Cached at the React
  // Query layer so reopening the sheet doesn't re-fetch on every tap.
  // While loading, fall back to the conservative default (every kind
  // except rate_con/invoice) so a slow settings fetch doesn't gate the
  // entire upload UI.
  const { data: orgSettings } = useQuery({
    queryKey: ["org-settings", orgId],
    queryFn:  () => fetchOrgSettings(orgId),
    staleTime: 5 * 60 * 1000,
  });
  const allowedKinds: DocumentKind[] = (
    orgSettings?.driverUploadKinds ?? ["pod", "bol", "scale", "lumper", "receipt", "driver_sheet", "relay_handoff", "other"]
  ).filter((k): k is DocumentKind => k in KIND_PRESETS && k !== "rate_con" && k !== "invoice");

  // Selected kind. Default to the first allowed kind so a tap on a
  // source immediately works — drivers don't have to remember to pick
  // one. They can still change it before tapping a source.
  const [kind, setKind] = useState<DocumentKind>(allowedKinds[0] ?? "other");
  useEffect(() => {
    // If the allowed list changes (org settings hydrate, or admin
    // disables a kind), snap to a still-allowed default.
    if (!allowedKinds.includes(kind) && allowedKinds.length > 0) {
      setKind(allowedKinds[0]);
    }
  }, [allowedKinds, kind]);

  async function scanToPdf() {
    try {
      setStep("scanning");
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
      });
      if (!scannedImages || scannedImages.length === 0) { setStep("idle"); return; }

      setStep("converting");
      // Compress each scanned page first so the resulting PDF stays under MAX_BYTES.
      // Inline as base64 data URL — file:// URIs aren't resolved when the PDF renders.
      const dataUrls = await Promise.all(
        scannedImages.map(async (uri) => {
          const compressed = await compressForPdfPage(uri, scannedImages.length);
          const b64 = await FileSystem.readAsStringAsync(compressed.uri, { encoding: "base64" });
          return `data:image/jpeg;base64,${b64}`;
        }),
      );
      const pages = dataUrls
        .map((url, i) =>
          `<div class="page${i < dataUrls.length - 1 ? ' break' : ''}">` +
          `<img src="${url}" />` +
          `</div>`
        )
        .join("");
      const html =
        `<html><head><style>` +
          `@page { margin: 0; size: letter; }` +
          `html, body { margin: 0; padding: 0; height: 100%; }` +
          `.page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }` +
          `.break { page-break-after: always; }` +
          `img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }` +
        `</style></head><body>${pages}</body></html>`;
      const { uri } = await Print.printToFileAsync({ html });
      await doUpload(uri, buildFileName(kind, loadNum, "", "pdf"), "application/pdf");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.toLowerCase().includes("cancel")) { setStep("idle"); return; }
      Alert.alert("Scan failed", "Could not scan the document. Please try again.");
      setStep("idle");
    }
  }

  async function handleCamera() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to capture documents.");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9, allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const compressed = await compressImage(result.assets[0].uri);
      await doUpload(compressed.uri, buildFileName(kind, loadNum, "", "jpg"), compressed.mimeType);
    }
  }

  async function handleGallery() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.9, allowsEditing: false,
    });
    if (!result.canceled && result.assets[0]) {
      const compressed = await compressImage(result.assets[0].uri);
      await doUpload(compressed.uri, buildFileName(kind, loadNum, "", "jpg"), compressed.mimeType);
    }
  }

  async function handleFile() {
    const result = await DocumentPicker.getDocumentAsync({ type: ["application/pdf", "image/*"] });
    if (!result.canceled && result.assets[0]) {
      const a = result.assets[0];
      const isImage = (a.mimeType ?? "").startsWith("image/");
      let uri = a.uri;
      let mime = a.mimeType ?? "application/octet-stream";
      if (isImage) {
        const compressed = await compressImage(a.uri);
        uri = compressed.uri;
        mime = compressed.mimeType;
      }
      const ext = (a.name.split(".").pop() ?? "bin").toLowerCase();
      const base = a.name.replace(/\.[^.]+$/, "");
      await doUpload(uri, buildFileName(kind, loadNum, base, ext), mime);
    }
  }

  async function multiPhotoToPdf() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission needed", "Camera access is required to capture documents.");
      return;
    }

    const photoUris: string[] = [];
    let keepShooting = true;
    while (keepShooting) {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.85, allowsEditing: false,
      });
      if (result.canceled || !result.assets[0]) {
        if (photoUris.length === 0) return; // cancelled before any capture
        break;
      }
      photoUris.push(result.assets[0].uri);

      keepShooting = await new Promise<boolean>((resolve) => {
        Alert.alert(
          `${photoUris.length} page${photoUris.length === 1 ? "" : "s"} captured`,
          "Take another or finish?",
          [
            { text: "Finish",       onPress: () => resolve(false) },
            { text: "Take another", onPress: () => resolve(true)  },
          ],
          { cancelable: false },
        );
      });
    }
    if (photoUris.length === 0) return;

    setStep("converting");
    try {
      const dataUrls = await Promise.all(
        photoUris.map(async (uri) => {
          const compressed = await compressForPdfPage(uri, photoUris.length);
          const b64 = await FileSystem.readAsStringAsync(compressed.uri, { encoding: "base64" });
          return `data:image/jpeg;base64,${b64}`;
        }),
      );
      const pages = dataUrls
        .map((url, i) =>
          `<div class="page${i < dataUrls.length - 1 ? " break" : ""}">` +
          `<img src="${url}" />` +
          `</div>`
        )
        .join("");
      const html =
        `<html><head><style>` +
          `@page { margin: 0; size: letter; }` +
          `html, body { margin: 0; padding: 0; height: 100%; }` +
          `.page { width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; overflow: hidden; }` +
          `.break { page-break-after: always; }` +
          `img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; display: block; }` +
        `</style></head><body>${pages}</body></html>`;
      const { uri } = await Print.printToFileAsync({ html });
      await doUpload(uri, buildFileName(kind, loadNum, "", "pdf"), "application/pdf");
    } catch (err) {
      Alert.alert("Failed", err instanceof Error ? err.message : "Could not build PDF");
      setStep("idle");
    }
  }

  async function doUpload(fileUri: string, fileName: string, mimeType: string) {
    // Offline path: enqueue and exit. The file gets copied into the
    // app's document directory (so iOS can't purge it from cache) and
    // a NetInfo-driven drain in _layout.tsx picks it up on reconnect.
    if (online === false) {
      setStep("uploading");
      try {
        await enqueueUpload({ fileUri, fileName, mimeType, eventId, orgId, driverId, driverName, kind });
        Alert.alert(
          "Saved for upload",
          "You're offline — this document will upload automatically when you reconnect.",
        );
        onUploaded();
        onClose();
      } catch (err) {
        Alert.alert("Save failed", err instanceof Error ? err.message : "Could not save for offline upload");
      } finally {
        setStep("idle");
      }
      return;
    }
    setStep("uploading");
    try {
      await uploadDocument({ fileUri, fileName, mimeType, eventId, orgId, driverId, driverName, kind });
      onUploaded();
      onClose();
    } catch (err) {
      // Fallback: if the live upload fails for a network-y reason
      // (radio dropped between the online check and the request),
      // queue it instead of leaving the driver to retry by hand.
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeNetwork = /network|fetch|timeout|connection|offline/i.test(msg);
      if (looksLikeNetwork) {
        try {
          await enqueueUpload({ fileUri, fileName, mimeType, eventId, orgId, driverId, driverName, kind });
          Alert.alert("Saved for upload", "Connection dropped — we'll retry automatically.");
          onUploaded();
          onClose();
        } catch (qerr) {
          Alert.alert("Upload failed", msg);
        }
      } else {
        Alert.alert("Upload failed", msg);
      }
    } finally {
      setStep("idle");
    }
  }

  const busy = step !== "idle";
  const busyLabel =
    step === "scanning"   ? "Scanning…" :
    step === "converting" ? "Building PDF…" :
    step === "uploading"  ? "Uploading…" : "";

  const options: { label: string; sub: string; Icon: typeof ScanLine; action: () => void; primary?: boolean }[] = [
    { label: "Scan Document",       sub: "Auto-crop & filter, multi-page PDF",  Icon: ScanLine,  action: scanToPdf,        primary: true },
    { label: "Photos to PDF",       sub: "Take multiple photos, combined PDF",   Icon: Layers,    action: multiPhotoToPdf                },
    { label: "Take Photo",          sub: "Single image from camera",             Icon: Camera,    action: handleCamera                   },
    { label: "Photo Library",       sub: "Pick existing photo",                  Icon: ImageIcon, action: handleGallery                  },
    { label: "Browse Files",        sub: "PDF or image from Files",              Icon: FileText,  action: handleFile                     },
  ];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)", justifyContent: "flex-end" }}>
        <Pressable onPress={(e) => e.stopPropagation()}
          style={{
            backgroundColor: "#ffffff",
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingHorizontal: 18, paddingTop: 8, paddingBottom: 28,
          }}
        >
          {/* Handle */}
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#e8eaed", alignSelf: "center", marginBottom: 14 }} />

          {/* Header */}
          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
            <Text style={[txt(800), { fontSize: 18, color: "#202124", flex: 1 }]}>Add document</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <Text style={[txt(500), { fontSize: 13, color: "#5f6368", marginBottom: 14 }]}>
            Pick a document type, then choose a source. Your file is named for you using the load number and type.
          </Text>

          {/* Document type picker — must be picked before tapping a
              source. Filtered by the org's `driverUploadKinds` (Settings
              → Documents). rate_con + invoice are excluded by hard
              policy at the API too, so even a tampered list can't
              upload as those kinds. */}
          <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
            Document type
          </Text>
          {/* Defense-in-depth: if the server's allow-list arrives empty
              (org-config corruption, brand-new org pre-defaults, etc.),
              show a clear error instead of an invisible/blank chip rail
              that silently breaks the upload flow. */}
          {allowedKinds.length === 0 && (
            <View style={{
              padding: 12, borderRadius: 10, marginBottom: 12,
              backgroundColor: "#fef3c7", borderWidth: 1, borderColor: "#fde68a",
            }}>
              <Text style={[txt(700), { fontSize: 13, color: "#92400e", marginBottom: 2 }]}>
                No document types configured
              </Text>
              <Text style={[txt(500), { fontSize: 12, color: "#92400e" }]}>
                Ask dispatch to enable document types in Settings → Documents.
              </Text>
            </View>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            {allowedKinds.map((k) => {
              const preset = KIND_PRESETS[k];
              const active = kind === k;
              return (
                <TouchableOpacity
                  key={k}
                  onPress={() => setKind(k)}
                  activeOpacity={0.7}
                  style={{
                    paddingVertical: 9,
                    paddingHorizontal: 12,
                    borderRadius: 10,
                    backgroundColor: active ? `${preset.tint}15` : "#f8f9fa",
                    borderWidth: 1.5,
                    borderColor: active ? preset.tint : "#e8eaed",
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  {active ? <Check size={12} color={preset.tint} strokeWidth={2.6} /> : null}
                  <Text style={[txt(800), { fontSize: 12, color: active ? preset.tint : "#5f6368", letterSpacing: 0.3 }]}>
                    {preset.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Sources */}
          {busy ? (
            <View style={{ paddingVertical: 36, alignItems: "center" }}>
              <ActivityIndicator size="large" color="#1a73e8" />
              <Text style={[txt(700), { fontSize: 13, color: "#3c4043", marginTop: 12 }]}>{busyLabel}</Text>
            </View>
          ) : (
            <View style={{ borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#e8eaed" }}>
              {options.map((opt, i) => (
                <TouchableOpacity key={opt.label} onPress={opt.action} activeOpacity={0.7}
                  style={{
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                    paddingHorizontal: 14,
                    paddingVertical: 14,
                    backgroundColor: "#ffffff",
                    borderTopWidth: i === 0 ? 0 : 1,
                    borderTopColor: "#f1f3f4",
                  }}
                >
                  <View
                    style={{
                      width: 40, height: 40, borderRadius: 12,
                      backgroundColor: opt.primary ? "#e8f0fe" : "#f1f3f4",
                      alignItems: "center", justifyContent: "center",
                    }}
                  >
                    <opt.Icon size={18} color={opt.primary ? "#1a73e8" : "#3c4043"} strokeWidth={2.2} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[txt(800), { fontSize: 14, color: opt.primary ? "#1a73e8" : "#202124" }]}>
                      {opt.label}
                    </Text>
                    <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
                      {opt.sub}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
