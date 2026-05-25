import React, { useState } from "react";
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
import { uploadDocument, type DocumentKind } from "@/lib/api";
import { txt } from "@/lib/font";

type Props = {
  eventId:    string;
  loadNum?:   string;
  visible:    boolean;
  onClose:    () => void;
  onUploaded: () => void;
};

// 3 MB cap matches the driver UploadSheet and the server's body limit —
// keep them in sync if/when the API raises this.
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

async function fileSize(uri: string): Promise<number> {
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && "size" in info ? (info.size ?? 0) : 0;
}

/**
 * Resize+recompress an image until it fits under `targetBytes`. Always
 * encodes to JPEG (smaller than HEIC/PNG for photos) and steps down the
 * quality ladder; bails early if the source is already small enough
 * unless `force` is set (used by the multi-page PDF path because each
 * page needs to be smaller than the per-page budget regardless).
 */
// Always runs a single transcode pass through ImageManipulator JPEG so
// the output is provably JPEG bytes regardless of source format. Used
// to short-circuit when the input was already under the byte cap, but
// that leaked HEIC (iPhone source) through with a fake .jpg mime —
// unrenderable in browsers. The decode/encode cost is trivial vs. the
// upload itself.
async function compressImage(
  uri: string,
  opts: { targetBytes: number; maxWidth: number; force?: boolean } = {
    targetBytes: MAX_TOTAL_BYTES, maxWidth: 2000,
  },
): Promise<{ uri: string; mimeType: string }> {
  // Walk down a quality ladder, starting high so small inputs come out
  // near-lossless. Stop as soon as we're under the target.
  const qualities = [0.95, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];
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

async function compressForPdfPage(uri: string, pageCount: number): Promise<{ uri: string; mimeType: string }> {
  const perPageBytes = Math.max(Math.floor(MAX_TOTAL_BYTES / Math.max(pageCount, 1)) - 50_000, 200_000);
  return compressImage(uri, { targetBytes: perPageBytes, maxWidth: 1600, force: true });
}

function buildFileName(kind: DocumentKind, loadNum: string | undefined, suffix: string, ext: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");
  const parts = [kind.toUpperCase(), loadNum ? safe(loadNum) : "", suffix && safe(suffix)].filter(Boolean);
  return `${parts.join("_")}.${ext}`;
}

type Step = "idle" | "scanning" | "converting" | "uploading";

// Dispatcher-facing kinds — order reflects how often each shows up in
// the dispatch flow. Rate con first because that's the canonical inbound
// doc from brokers; driver_sheet + invoice are dispatch-only (drivers
// never originate those). Excludes "relay_handoff" which is field-only.
const KIND_OPTIONS: { key: DocumentKind; label: string; tint: string }[] = [
  { key: "rate_con",     label: "Rate Con",  tint: "#92400e" },
  { key: "bol",          label: "BOL",       tint: "#1a73e8" },
  { key: "pod",          label: "POD",       tint: "#15803d" },
  { key: "driver_sheet", label: "Sheet",     tint: "#6d28d9" },
  { key: "invoice",      label: "Invoice",   tint: "#9d174d" },
  { key: "other",        label: "Other",     tint: "#5f6368" },
];

export function UploadSheet({ eventId, loadNum, visible, onClose, onUploaded }: Props) {
  const [step, setStep] = useState<Step>("idle");
  const [kind, setKind] = useState<DocumentKind>("rate_con");

  async function scanToPdf() {
    try {
      setStep("scanning");
      const { scannedImages } = await DocumentScanner.scanDocument({
        croppedImageQuality: 90,
      });
      if (!scannedImages || scannedImages.length === 0) { setStep("idle"); return; }

      setStep("converting");
      // Inline scanned pages as base64 data URLs into the print HTML —
      // expo-print's HTML renderer doesn't resolve file:// references
      // reliably across platforms, so we ship the image bytes directly.
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
    setStep("uploading");
    try {
      await uploadDocument({ fileUri, fileName, mimeType, eventId, kind });
      onUploaded();
      onClose();
    } catch (err) {
      Alert.alert("Upload failed", err instanceof Error ? err.message : "Could not upload");
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
    { label: "Photos to PDF",       sub: "Take multiple photos, combined PDF",  Icon: Layers,    action: multiPhotoToPdf                },
    { label: "Take Photo",          sub: "Single image from camera",            Icon: Camera,    action: handleCamera                   },
    { label: "Photo Library",       sub: "Pick existing photo",                 Icon: ImageIcon, action: handleGallery                  },
    { label: "Browse Files",        sub: "PDF or image from Files",             Icon: FileText,  action: handleFile                     },
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
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: "#e8eaed", alignSelf: "center", marginBottom: 14 }} />

          <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
            <Text style={[txt(800), { fontSize: 18, color: "#202124", flex: 1 }]}>Add document</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10}>
              <X size={20} color="#5f6368" strokeWidth={2.2} />
            </TouchableOpacity>
          </View>
          <Text style={[txt(500), { fontSize: 13, color: "#5f6368", marginBottom: 14 }]}>
            Rate cons, BOLs, PODs, anything paperwork.
          </Text>

          <Text style={[txt(800), { fontSize: 11, letterSpacing: 1, color: "#5f6368", textTransform: "uppercase", marginBottom: 8 }]}>
            Document type
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 18 }}>
            {KIND_OPTIONS.map((opt) => {
              const active = kind === opt.key;
              return (
                <TouchableOpacity key={opt.key} onPress={() => setKind(opt.key)} activeOpacity={0.7}
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
