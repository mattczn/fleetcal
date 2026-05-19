import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator,
  Modal, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, X, Share2, Plus } from "lucide-react-native";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { fetchDocuments, type LoadDocument } from "@/lib/api";
import { railway } from "@/lib/railway";
import { UploadSheet } from "@/components/UploadSheet";
import { txt } from "@/lib/font";

const KIND_TINT: Record<string, { bg: string; fg: string }> = {
  bol:   { bg: "#e8f0fe", fg: "#1558d6" },
  pod:   { bg: "#dcfce7", fg: "#15803d" },
  scale: { bg: "#fff7ed", fg: "#9a3412" },
  other: { bg: "#f1f3f4", fg: "#3c4043" },
};

function fmtUploaded(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtBytes(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isImage(doc: LoadDocument): boolean {
  return (doc.mimeType ?? "").startsWith("image/")
    || /\.(jpg|jpeg|png|webp|heic)$/i.test(doc.fileName);
}

async function fetchSignedUrl(doc: LoadDocument, isRateCon: boolean, loadId?: string): Promise<string | null> {
  try {
    if (isRateCon) {
      if (!loadId) return null;
      const { url } = await railway.getRateConUrl(loadId);
      return url;
    }
    const { url } = await railway.getDocumentUrl(doc.id);
    return url;
  } catch (err) {
    console.warn("fetchSignedUrl:", err);
    return null;
  }
}

/**
 * Download the document to the cache directory and hand it to the OS share
 * sheet. Sharing on iOS/Android needs a `file://` URI, not a remote URL —
 * we can't just hand it the signed URL.
 */
async function shareDocument(url: string, doc: LoadDocument): Promise<void> {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      Alert.alert("Sharing not available", "This device can't share files.");
      return;
    }
    const safeName = (doc.fileName || "document").replace(/[^A-Za-z0-9._-]/g, "_");
    const dest = (FileSystem.cacheDirectory ?? "") + safeName;
    const { uri } = await FileSystem.downloadAsync(url, dest);
    await Sharing.shareAsync(uri, {
      mimeType: doc.mimeType,
      UTI:      doc.mimeType === "application/pdf" ? "com.adobe.pdf" : undefined,
    });
  } catch (err) {
    Alert.alert("Couldn't share", err instanceof Error ? err.message : "Unknown error");
  }
}

function DocumentRow({ doc, onPress, isRateCon, loadId }: { doc: LoadDocument; onPress: () => void; isRateCon?: boolean; loadId?: string }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const tint = isRateCon
    ? { bg: "#fef3c7", fg: "#92400e" }
    : (KIND_TINT[doc.kind] ?? KIND_TINT.other);

  React.useEffect(() => {
    if (isImage(doc)) {
      void fetchSignedUrl(doc, !!isRateCon, loadId).then(setThumbUrl);
    }
  }, [doc, isRateCon, loadId]);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={{
        flexDirection: "row", gap: 12,
        backgroundColor: "#ffffff", borderRadius: 14,
        padding: 12, marginBottom: 10,
        borderWidth: 1, borderColor: "#e8eaed",
      }}
    >
      {isImage(doc) && thumbUrl ? (
        <Image source={{ uri: thumbUrl }} style={{ width: 56, height: 56, borderRadius: 10 }} />
      ) : (
        <View style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: "#f1f3f4", alignItems: "center", justifyContent: "center" }}>
          <FileText size={22} color="#5f6368" strokeWidth={2.2} />
        </View>
      )}
      <View style={{ flex: 1, justifyContent: "center" }}>
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint.bg, marginBottom: 4 }}>
          <Text style={[txt(800), { fontSize: 10, color: tint.fg, letterSpacing: 0.4 }]}>
            {isRateCon ? "RATE CON" : doc.kind.toUpperCase()}
          </Text>
        </View>
        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
          {doc.fileName}
        </Text>
        <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
          {fmtUploaded(doc.uploadedAt)}{doc.sizeBytes ? ` · ${fmtBytes(doc.sizeBytes)}` : ""}
        </Text>
      </View>
    </TouchableOpacity>
  );
}

function ViewerModal({ doc, isRateCon, loadId, visible, onClose }: { doc: LoadDocument | null; isRateCon?: boolean; loadId?: string; visible: boolean; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (visible && doc) {
      setUrl(null);
      void fetchSignedUrl(doc, !!isRateCon, loadId).then(setUrl);
    }
  }, [visible, doc, isRateCon, loadId]);

  if (!doc) return null;

  return (
    <Modal visible={visible} animationType="fade" presentationStyle="overFullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <View style={{ paddingTop: insets.top, flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingTop: 8, paddingBottom: 12, gap: 12 }}>
            <TouchableOpacity onPress={onClose} hitSlop={14}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(255,255,255,0.18)", alignItems: "center", justifyContent: "center" }}>
              <X size={20} color="#ffffff" strokeWidth={2.4} />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[txt(800), { fontSize: 14, color: "#ffffff" }]} numberOfLines={1}>{doc.fileName}</Text>
              <Text style={[txt(500), { fontSize: 11, color: "rgba(255,255,255,0.55)" }]}>
                {fmtUploaded(doc.uploadedAt)}
              </Text>
            </View>
            <TouchableOpacity
              onPress={async () => {
                if (!url || sharing) return;
                setSharing(true);
                try { await shareDocument(url, doc); }
                finally { setSharing(false); }
              }}
              hitSlop={14}
              disabled={!url || sharing}
              style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: "rgba(255,255,255,0.18)",
                alignItems: "center", justifyContent: "center",
                opacity: url && !sharing ? 1 : 0.5,
              }}
            >
              {sharing ? (
                <ActivityIndicator color="#ffffff" />
              ) : (
                <Share2 size={18} color="#ffffff" strokeWidth={2.4} />
              )}
            </TouchableOpacity>
          </View>
          <View style={{ flex: 1 }}>
            {!url ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color="#ffffff" />
              </View>
            ) : isImage(doc) ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 12 }}>
                <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
              </View>
            ) : (
              <WebView source={{ uri: url }} style={{ flex: 1, backgroundColor: "#000000" }} originWhitelist={["*"]} startInLoadingState />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface Props {
  eventId:     string;
  orgId:       string;
  loadId?:     string;        // needed to resolve the rate-con signed URL
  loadNum?:    string;        // used in upload filenames; cosmetic only
  rateConPath?: string;       // null/missing means no rate con attached
  width:       number;
}

/** Documents tab — list, tap to view, "Add Document" launches camera/scan/file picker. */
export function DocumentsView({ eventId, orgId, loadId, loadNum, rateConPath, width }: Props) {
  const queryClient = useQueryClient();
  const [viewerDoc, setViewerDoc] = useState<LoadDocument | null>(null);
  const [viewerIsRateCon, setViewerIsRateCon] = useState(false);
  const [uploadVisible, setUploadVisible] = useState(false);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["documents", eventId],
    queryFn:  () => fetchDocuments(eventId, orgId),
  });

  // Synthesize a Rate Con "doc" so the row UI can render it. The id is
  // never used for URL resolution (we look up via loadId instead).
  const rateConDoc: LoadDocument | null = rateConPath ? {
    id:          "rate-con",
    eventId,
    fileName:    rateConPath.split("/").pop() ?? "Rate Con",
    kind:        "other",
    uploadedAt:  "",
  } : null;

  const total = docs.length + (rateConDoc ? 1 : 0);

  return (
    <View style={{ width, flex: 1 }}>
      <ScrollView style={{ flex: 1, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <TouchableOpacity onPress={() => setUploadVisible(true)} activeOpacity={0.85}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            paddingVertical: 14,
            borderRadius: 14,
            backgroundColor: "#1a73e8",
            shadowColor: "#1a73e8", shadowOpacity: 0.3, shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
            marginBottom: 16,
          }}>
          <Plus size={16} color="#ffffff" strokeWidth={2.6} />
          <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
            Add Document
          </Text>
        </TouchableOpacity>

        <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
          Documents · {total}
        </Text>

        {isLoading ? (
          <View style={{ paddingVertical: 30, alignItems: "center" }}>
            <ActivityIndicator color="#1a73e8" />
          </View>
        ) : total === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#e8f0fe", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
              <FileText size={26} color="#1a73e8" strokeWidth={2} />
            </View>
            <Text style={[txt(700), { fontSize: 15, color: "#3c4043", textAlign: "center" }]}>
              No documents yet
            </Text>
            <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
              Rate cons and driver uploads will show up here.
            </Text>
          </View>
        ) : (
          <>
            {rateConDoc ? (
              <DocumentRow
                doc={rateConDoc}
                isRateCon
                loadId={loadId}
                onPress={() => { setViewerIsRateCon(true); setViewerDoc(rateConDoc); }}
              />
            ) : null}
            {docs.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                onPress={() => { setViewerIsRateCon(false); setViewerDoc(doc); }}
              />
            ))}
          </>
        )}
      </ScrollView>

      <ViewerModal
        doc={viewerDoc}
        isRateCon={viewerIsRateCon}
        loadId={loadId}
        visible={!!viewerDoc}
        onClose={() => { setViewerDoc(null); setViewerIsRateCon(false); }}
      />

      <UploadSheet
        eventId={eventId}
        loadNum={loadNum}
        visible={uploadVisible}
        onClose={() => setUploadVisible(false)}
        onUploaded={() => {
          queryClient.invalidateQueries({ queryKey: ["documents", eventId] });
        }}
      />
    </View>
  );
}
