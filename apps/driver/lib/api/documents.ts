import * as FileSystem from "expo-file-system/legacy";
import { supabase } from "@/lib/supabase";
import { appendEventAuditEntry } from "@/lib/api/loads";

const BUCKET = "load-documents";

export type DocumentKind = "bol" | "pod" | "scale" | "other";

export interface LoadDocument {
  id:           string;
  eventId:      string;
  storagePath:  string;
  fileName:     string;
  mimeType?:    string;
  sizeBytes?:   number;
  kind:         DocumentKind;
  uploadedAt:   string;
  uploadedByDriverId?: number;
  notes?:       string;
}

interface DbRow {
  id: string;
  event_id: string;
  storage_path: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  kind: string;
  uploaded_at: string;
  uploaded_by_driver_id: number | null;
  notes: string | null;
}

function rowToDoc(r: DbRow): LoadDocument {
  return {
    id:           r.id,
    eventId:      r.event_id,
    storagePath:  r.storage_path,
    fileName:     r.file_name,
    mimeType:     r.mime_type ?? undefined,
    sizeBytes:    r.size_bytes ?? undefined,
    kind:         (r.kind as DocumentKind) ?? "other",
    uploadedAt:   r.uploaded_at,
    uploadedByDriverId: r.uploaded_by_driver_id ?? undefined,
    notes:        r.notes ?? undefined,
  };
}

export async function fetchDocuments(
  eventId: string,
  orgId: string,
): Promise<LoadDocument[]> {
  const { data, error } = await supabase
    .from("load_documents")
    .select("*")
    .eq("event_id", eventId)
    .eq("org_id",   orgId)
    .order("uploaded_at", { ascending: false });
  if (error) {
    console.error("fetchDocuments:", error);
    return [];
  }
  return (data ?? []).map((r) => rowToDoc(r as DbRow));
}

/**
 * Upload a local file (image or PDF) to the storage bucket and write the metadata row.
 * Path: <org_id>/<event_id>/<timestamp>_<random>.<ext>
 */
export async function uploadDocument(args: {
  fileUri:    string;
  fileName:   string;
  mimeType:   string;
  eventId:    string;
  orgId:      string;
  driverId:   number;
  driverName?: string;
  kind:       DocumentKind;
}): Promise<LoadDocument> {
  const ext = args.fileName.split(".").pop() ?? "bin";
  const random = Math.random().toString(36).slice(2, 10);
  const storagePath = `${args.orgId}/${args.eventId}/${Date.now()}_${random}.${ext}`;

  const base64 = await FileSystem.readAsStringAsync(args.fileUri, {
    encoding: "base64",
  });
  const bytes = decodeBase64(base64);

  const { error: uploadErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes.buffer as ArrayBuffer, {
      contentType: args.mimeType,
      upsert: false,
    });
  if (uploadErr) { console.error("uploadDocument storage:", uploadErr); throw uploadErr; }

  const { data, error } = await supabase
    .from("load_documents")
    .insert({
      event_id:              args.eventId,
      org_id:                args.orgId,
      storage_path:          storagePath,
      file_name:             args.fileName,
      mime_type:             args.mimeType,
      size_bytes:            bytes.length,
      kind:                  args.kind,
      uploaded_by_driver_id: args.driverId,
    })
    .select("*")
    .single();
  if (error || !data) {
    console.error("uploadDocument insert:", error);
    throw error ?? new Error("Insert returned no row");
  }
  if (args.driverName) {
    await appendEventAuditEntry(args.eventId, args.orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: args.driverName,
      documentUploaded: { fileName: args.fileName, kind: args.kind },
    });
  }
  return rowToDoc(data as DbRow);
}

export async function deleteDocument(
  doc: LoadDocument,
  orgId: string,
  driverName?: string,
): Promise<void> {
  await Promise.all([
    supabase.storage.from(BUCKET).remove([doc.storagePath]),
    supabase.from("load_documents").delete().eq("id", doc.id).eq("org_id", orgId),
  ]);
  if (driverName) {
    await appendEventAuditEntry(doc.eventId, orgId, {
      changedAt:    new Date().toISOString(),
      changedByName: driverName,
      documentDeleted: { fileName: doc.fileName, kind: doc.kind },
    });
  }
}

export async function getSignedUrl(storagePath: string, expiresInSec = 3600): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, expiresInSec);
  if (error || !data) { console.error("getSignedUrl:", error); return null; }
  return data.signedUrl;
}

// base64 → Uint8Array (atob isn't always available in RN runtimes)
function decodeBase64(str: string): Uint8Array {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) lookup[chars.charCodeAt(i)] = i;
  let bufferLength = (str.length * 3) / 4;
  if (str[str.length - 1] === "=") bufferLength--;
  if (str[str.length - 2] === "=") bufferLength--;
  const out = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < str.length; i += 4) {
    const e1 = lookup[str.charCodeAt(i)];
    const e2 = lookup[str.charCodeAt(i + 1)];
    const e3 = lookup[str.charCodeAt(i + 2)];
    const e4 = lookup[str.charCodeAt(i + 3)];
    out[p++] = (e1 << 2) | (e2 >> 4);
    if (str[i + 2] !== "=") out[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (str[i + 3] !== "=") out[p++] = ((e3 & 3)  << 6) |  e4;
  }
  return out;
}
