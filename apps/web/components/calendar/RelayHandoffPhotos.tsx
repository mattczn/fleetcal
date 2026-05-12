/**
 * Relay handoff photos — web view.
 *
 * Driver app uploads photos to load_documents with kind='relay_handoff'.
 * This component shows them inside the EventModal's relay block on
 * both the pickup leg and the delivery leg. Clicking a thumbnail
 * opens the existing side-panel docs viewer (same pattern as rate-con
 * + uploaded paperwork) so download / delete are handled there
 * instead of with a separate lightbox. Uploads go through the parent
 * so a single docs cache stays authoritative.
 */
'use client';

import { useRef } from 'react';
import { ArrowLeftRight, Image as ImageIcon, Upload, Loader2 } from 'lucide-react';
import { railway } from '@/lib/railway';

interface RelayPhotoRow {
  id: string;
  fileName: string;
  uploadedAt: string;
  signedUrl?: string;
}

interface Props {
  loadId: string;
  /** Pre-filtered handoff photos. Sourced from the parent's
   *  loadDocuments so deletes/uploads stay in sync without a duplicate
   *  fetch in this component. */
  photos: RelayPhotoRow[];
  /** Open the docs side panel (rate-con style viewer) on the given
   *  doc. The parent wires this to set showPdfViewer + docsTab +
   *  selectedDocId. */
  onSelectInPanel?: (docId: string) => void;
  /** Called after a successful upload so the parent can re-fetch the
   *  shared loadDocuments list. */
  onUploaded?: () => void | Promise<void>;
}

export function RelayHandoffPhotos({ loadId, photos, onSelectInPanel, onUploaded }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadingRef = useRef(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (uploadingRef.current) return;
    uploadingRef.current = true;
    try {
      for (const file of Array.from(files)) {
        await railway.uploadLoadDocument(loadId, file, 'relay_handoff');
      }
      await onUploaded?.();
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      uploadingRef.current = false;
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  return (
    <div className="rounded-lg" style={{ background: 'rgba(255,255,255,0.65)', padding: 12 }}>
      <div className="flex items-center gap-2 mb-2">
        <ImageIcon size={14} style={{ color: '#6b21a8' }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: '#6b21a8' }}>
          Handoff Photos
        </span>
        {photos.length > 0 && (
          <span className="text-[11px]" style={{ color: '#6b21a8', opacity: 0.65 }}>
            · {photos.length}
          </span>
        )}
        <div className="ml-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={e => void handleFiles(e.target.files)}
            style={{ display: 'none' }}
          />
          <button type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors"
            style={{ background: '#6b21a8', color: '#fff', cursor: 'pointer' }}>
            <Upload size={11} /> Upload
          </button>
        </div>
      </div>
      {photos.length === 0 ? (
        <button type="button"
          onClick={() => fileInputRef.current?.click()}
          className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-[12px] font-semibold transition-colors"
          style={{
            border: '1.5px dashed #8b5cf6',
            background: 'rgba(255,255,255,0.45)',
            color: '#6b21a8',
            cursor: 'pointer',
          }}>
          <Upload size={12} /> Upload the first handoff photo
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {photos.map(p => (
            <button key={p.id}
              type="button"
              onClick={() => onSelectInPanel?.(p.id)}
              title={p.fileName}
              className="rounded-md overflow-hidden hover:opacity-90 transition-opacity"
              style={{ width: 72, height: 72, background: '#ede9fe', border: '1px solid #ddd6fe', cursor: onSelectInPanel ? 'pointer' : 'default' }}>
              {p.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.signedUrl} alt={p.fileName}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Loader2 size={14} className="animate-spin" style={{ color: '#6b21a8' }} />
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact title-row marker for the relay banner. Just shows "Handoff
// photos: N" with an icon — for use in headers/summaries where the
// full grid would be too noisy. Reads from a passed-in count so it
// shares the parent's cache.
export function RelayHandoffPhotosCount({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold"
      style={{ color: '#6b21a8' }}>
      <ArrowLeftRight size={11} /> {count} handoff photo{count === 1 ? '' : 's'}
    </span>
  );
}
