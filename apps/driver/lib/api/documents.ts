/**
 * Driver-app document helpers. List/upload/delete now go through the
 * Railway API (/v1/driver/loads/:id/documents and friends). Signed-URL
 * lookups switched from storage path → document id; old call sites that
 * still pass a storagePath need updating to the doc id.
 */
import { railway } from "@/lib/railway";

// Mirrors the canonical DocumentKind in packages/types/api.ts. The
// driver UI surfaces a smaller subset today (see UploadSheet's
// KIND_OPTIONS) — adding more chips there is a UX choice, not a
// data-model gate.
export type DocumentKind =
  | "rate_con"
  | "pod"
  | "bol"
  | "scale"
  | "lumper"
  | "receipt"
  | "driver_sheet"
  | "invoice"
  | "relay_handoff"
  | "other";

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

export async function fetchDocuments(
  eventId: string,
  _orgId:  string,
): Promise<LoadDocument[]> {
  try {
    const { documents } = await railway.listDocuments(eventId);
    return documents as LoadDocument[];
  } catch (err) {
    console.error("fetchDocuments:", err);
    return [];
  }
}

/**
 * Upload a local file (image or PDF) by streaming it through the API as
 * multipart/form-data. The API handles bucket upload, row insert, and
 * audit logging in one round-trip.
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
  const form = new FormData();
  // React Native's FormData accepts a {uri, name, type} blob descriptor —
  // typing isn't quite right in TS, so we cast.
  form.append("file", {
    uri:  args.fileUri,
    name: args.fileName,
    type: args.mimeType,
  } as unknown as Blob);
  form.append("kind", args.kind);

  const { document } = await railway.uploadDocument(args.eventId, form);
  return document as LoadDocument;
}

export async function deleteDocument(
  doc: LoadDocument,
  _orgId: string,
  _driverName?: string,
): Promise<void> {
  await railway.deleteDocument(doc.id);
}

/**
 * Rename and/or recategorize an existing document. Either field is
 * optional — pass only what's changing. Server validates that `kind`
 * is in the canonical DocumentKind enum.
 */
export async function updateDocument(
  id: string,
  patch: { fileName?: string; kind?: DocumentKind },
): Promise<void> {
  await railway.updateDocument(id, patch);
}

/**
 * Resolve a viewable URL for a document. The new API surface keys on
 * the document id, so we ignore the legacy `storagePath` argument and
 * accept it via overload — old call sites still compile, but new ones
 * should pass an id.
 */
export async function getSignedUrl(idOrPath: string, _expiresInSec = 3600): Promise<string | null> {
  try {
    const { url } = await railway.getDocumentUrl(idOrPath);
    return url;
  } catch (err) {
    console.error("getSignedUrl:", err);
    return null;
  }
}
