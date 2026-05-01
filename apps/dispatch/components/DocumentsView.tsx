import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { useQuery } from "@tanstack/react-query";
import { FileText, X } from "lucide-react-native";
import { fetchDocuments, getDocumentSignedUrl, getRateConSignedUrl, type LoadDocument } from "@/lib/api";
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

function DocumentRow({ doc, onPress, isRateCon }: { doc: LoadDocument; onPress: () => void; isRateCon?: boolean }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const tint = isRateCon
    ? { bg: "#fef3c7", fg: "#92400e" }
    : (KIND_TINT[doc.kind] ?? KIND_TINT.other);

  React.useEffect(() => {
    if (isImage(doc)) {
      const fetcher = isRateCon ? getRateConSignedUrl : getDocumentSignedUrl;
      fetcher(doc.storagePath, 3600).then(setThumbUrl);
    }
  }, [doc.storagePath, doc, isRateCon]);

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

function ViewerModal({ doc, isRateCon, visible, onClose }: { doc: LoadDocument | null; isRateCon?: boolean; visible: boolean; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (visible && doc) {
      setUrl(null);
      const fetcher = isRateCon ? getRateConSignedUrl : getDocumentSignedUrl;
      fetcher(doc.storagePath, 3600).then(setUrl);
    }
  }, [visible, doc, isRateCon]);

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
  rateConPath?: string;
  width:       number;
}

/** Read-only documents tab — list + tap to view. No upload UI. */
export function DocumentsView({ eventId, orgId, rateConPath, width }: Props) {
  const [viewerDoc, setViewerDoc] = useState<LoadDocument | null>(null);
  const [viewerIsRateCon, setViewerIsRateCon] = useState(false);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ["documents", eventId],
    queryFn:  () => fetchDocuments(eventId, orgId),
  });

  // Synthesize a Rate Con "doc" from the event's rate_con_pdf storage path.
  const rateConDoc: LoadDocument | null = rateConPath ? {
    id:          "rate-con",
    eventId,
    storagePath: rateConPath,
    fileName:    rateConPath.split("/").pop() ?? "Rate Con",
    kind:        "other",
    uploadedAt:  "",
  } : null;

  const total = docs.length + (rateConDoc ? 1 : 0);

  return (
    <View style={{ width, flex: 1 }}>
      <ScrollView style={{ flex: 1, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
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
        visible={!!viewerDoc}
        onClose={() => { setViewerDoc(null); setViewerIsRateCon(false); }}
      />
    </View>
  );
}
