import React, { useState } from "react";
import {
  View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator,
  Modal, Alert,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Plus, Trash2, X } from "lucide-react-native";
import { fetchDocuments, getSignedUrl, deleteDocument, type LoadDocument } from "@/lib/api/documents";
import { UploadSheet } from "@/components/UploadSheet";

const txt = (weight: 500 | 600 | 700 | 800) => ({
  fontFamily:
    weight === 500 ? "PlusJakartaSans_500Medium"  :
    weight === 600 ? "PlusJakartaSans_600SemiBold" :
    weight === 700 ? "PlusJakartaSans_700Bold"     :
                     "PlusJakartaSans_800ExtraBold",
});

const KIND_TINT: Record<string, { bg: string; fg: string }> = {
  bol:   { bg: "#e8f0fe", fg: "#1558d6" },
  pod:   { bg: "#dcfce7", fg: "#15803d" },
  scale: { bg: "#fff7ed", fg: "#9a3412" },
  other: { bg: "#f1f3f4", fg: "#3c4043" },
};

function fmtUploaded(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
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

function DocumentRow({ doc, onPress, onDelete }: { doc: LoadDocument; onPress: () => void; onDelete: () => void }) {
  const [thumbUrl, setThumbUrl] = useState<string | null>(null);
  const tint = KIND_TINT[doc.kind] ?? KIND_TINT.other;

  React.useEffect(() => {
    if (isImage(doc)) {
      getSignedUrl(doc.id, 3600).then(setThumbUrl);
    }
  }, [doc.storagePath, doc]);

  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7}
      style={{
        flexDirection: "row",
        gap: 12,
        backgroundColor: "#ffffff",
        borderRadius: 14,
        padding: 12,
        marginBottom: 10,
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
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: tint.bg }}>
            <Text style={[txt(800), { fontSize: 10, color: tint.fg, letterSpacing: 0.4 }]}>
              {doc.kind.toUpperCase()}
            </Text>
          </View>
        </View>
        <Text style={[txt(700), { fontSize: 14, color: "#202124" }]} numberOfLines={1}>
          {doc.fileName}
        </Text>
        <Text style={[txt(500), { fontSize: 12, color: "#5f6368", marginTop: 1 }]}>
          {fmtUploaded(doc.uploadedAt)}{doc.sizeBytes ? ` · ${fmtBytes(doc.sizeBytes)}` : ""}
        </Text>
      </View>

      <TouchableOpacity onPress={onDelete} hitSlop={10}
        style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: 4 }}>
        <Trash2 size={16} color="#9aa0a6" strokeWidth={2.2} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

function ViewerModal({ doc, visible, onClose }: { doc: LoadDocument | null; visible: boolean; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const insets = useSafeAreaInsets();

  React.useEffect(() => {
    if (visible && doc) {
      setUrl(null);
      getSignedUrl(doc.id, 3600).then(setUrl);
    }
  }, [visible, doc]);

  if (!doc) return null;

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "#000000" }}>
        <View style={{ paddingTop: insets.top, flex: 1 }}>
          <View style={{
            flexDirection: "row", alignItems: "center", paddingHorizontal: 14,
            paddingTop: 8, paddingBottom: 12, gap: 12,
          }}>
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

          <View style={{ flex: 1, padding: 0 }}>
            {!url ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                <ActivityIndicator color="#ffffff" />
              </View>
            ) : isImage(doc) ? (
              <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 12 }}>
                <Image source={{ uri: url }} style={{ width: "100%", height: "100%" }} resizeMode="contain" />
              </View>
            ) : (
              <WebView
                source={{ uri: url }}
                style={{ flex: 1, backgroundColor: "#000000" }}
                originWhitelist={["*"]}
                startInLoadingState
                renderLoading={() => (
                  <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#000000" }}>
                    <ActivityIndicator color="#ffffff" />
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface Props {
  eventId:        string;
  orgId:          string;
  driverId:       number;
  driverName:     string;
  loadNum?:       string;
  uploadVisible:  boolean;
  setUploadVisible: (v: boolean) => void;
  width:          number;
}

/**
 * Inline documents tab for the load detail screen — list, view, delete, upload.
 * Width is passed in so it can sit inside a horizontal paged ScrollView.
 */
export function DocumentsView({
  eventId, orgId, driverId, driverName, loadNum,
  uploadVisible, setUploadVisible,
  width,
}: Props) {
  const queryClient = useQueryClient();
  const [viewerDoc, setViewerDoc] = useState<LoadDocument | null>(null);

  const { data: docs = [], refetch, isLoading } = useQuery({
    queryKey: ["documents", eventId],
    queryFn:  () => fetchDocuments(eventId, orgId),
  });

  function handleDelete(doc: LoadDocument) {
    Alert.alert("Delete document?", `Remove ${doc.fileName}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete", style: "destructive",
        onPress: async () => {
          await deleteDocument(doc, orgId, driverName);
          queryClient.invalidateQueries({ queryKey: ["documents", eventId] });
        },
      },
    ]);
  }

  return (
    <View style={{ width, flex: 1 }}>
      <ScrollView style={{ flex: 1, backgroundColor: "#f8f9fa" }} contentContainerStyle={{ padding: 16, paddingBottom: 120 }}>
        <TouchableOpacity onPress={() => setUploadVisible(true)} activeOpacity={0.85}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            paddingVertical: 16,
            borderRadius: 16,
            backgroundColor: "#1a73e8",
            shadowColor: "#1a73e8", shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
            marginBottom: 18,
          }}>
          <Plus size={16} color="#ffffff" strokeWidth={2.6} />
          <Text style={[txt(800), { fontSize: 14, color: "#ffffff", letterSpacing: 0.3 }]}>
            Add Document
          </Text>
        </TouchableOpacity>

        <Text style={[txt(800), { fontSize: 11, letterSpacing: 1.1, color: "#5f6368", textTransform: "uppercase", marginBottom: 10 }]}>
          Uploaded · {docs.length}
        </Text>

        {isLoading ? (
          <View style={{ paddingVertical: 30, alignItems: "center" }}>
            <ActivityIndicator color="#1a73e8" />
          </View>
        ) : docs.length === 0 ? (
          <View style={{ paddingVertical: 40, alignItems: "center" }}>
            <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: "#e8f0fe", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
              <FileText size={26} color="#1a73e8" strokeWidth={2} />
            </View>
            <Text style={[txt(700), { fontSize: 15, color: "#3c4043", textAlign: "center" }]}>
              No documents yet
            </Text>
            <Text style={[txt(500), { fontSize: 13, color: "#9aa0a6", marginTop: 4, textAlign: "center" }]}>
              Add a BOL, POD, or any other paperwork
            </Text>
          </View>
        ) : (
          docs.map((doc) => (
            <DocumentRow
              key={doc.id}
              doc={doc}
              onPress={() => setViewerDoc(doc)}
              onDelete={() => handleDelete(doc)}
            />
          ))
        )}
      </ScrollView>

      <UploadSheet
        eventId={eventId}
        loadNum={loadNum}
        orgId={orgId}
        driverId={driverId}
        driverName={driverName}
        visible={uploadVisible}
        onClose={() => setUploadVisible(false)}
        onUploaded={() => {
          refetch();
          queryClient.invalidateQueries({ queryKey: ["documents", eventId] });
        }}
      />

      <ViewerModal
        doc={viewerDoc}
        visible={!!viewerDoc}
        onClose={() => setViewerDoc(null)}
      />
    </View>
  );
}
