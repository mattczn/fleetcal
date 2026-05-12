/**
 * Relay handoff photos — web view.
 *
 * Driver app uploads photos to load_documents with kind='relay_handoff'.
 * This component shows them inside the EventModal's relay block on
 * both the pickup leg and the delivery leg. Ops can view, upload, and
 * delete — useful when a driver phones in a photo or ops needs to
 * pre-stage paperwork before the load goes out.
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Image as ImageIcon, X, ExternalLink, Trash2, Upload, Loader2 } from 'lucide-react';
import { railway } from '@/lib/railway';

interface RelayPhotoRow {
  id: string;
  kind: string;
  fileName: string;
  uploadedAt: string;
  signedUrl?: string;
}

interface Props {
  loadId: string;
}

export function RelayHandoffPhotos({ loadId }: Props) {
  const [photos,  setPhotos]  = useState<RelayPhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState<RelayPhotoRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await railway.listLoadDocuments(loadId);
      const all = res.documents ?? [];
      const relay = all
        .filter(d => d.kind === 'relay_handoff')
        .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
      // Cast — the typed response uses a stricter DocumentKind union;
      // we narrowed at runtime above.
      setPhotos(relay as unknown as RelayPhotoRow[]);
    } catch (err) {
      console.warn('[relay photos web] list:', err);
    } finally {
      setLoading(false);
    }
  }, [loadId]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function handleDelete(d: RelayPhotoRow) {
    if (!confirm('Delete this handoff photo?')) return;
    try {
      await railway.deleteDocument(d.id);
      await refresh();
    } catch (err) {
      alert(`Delete failed: ${(err as Error).message}`);
    }
  }

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      // Upload sequentially — keeps API logs tidy and lets us bail early
      // if a single file fails, without partial-failure ambiguity.
      for (const file of Array.from(files)) {
        await railway.uploadLoadDocument(loadId, file, 'relay_handoff');
      }
      await refresh();
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
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
            disabled={uploading}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors"
            style={{
              background: uploading ? '#a78bfa' : '#6b21a8',
              color: '#fff',
              opacity: uploading ? 0.7 : 1,
              cursor: uploading ? 'wait' : 'pointer',
            }}>
            {uploading
              ? <><Loader2 size={11} className="animate-spin" /> Uploading…</>
              : <><Upload size={11} /> Upload</>}
          </button>
        </div>
      </div>
      {loading ? (
        <div className="text-[12px]" style={{ color: '#6b21a8', opacity: 0.7 }}>Loading…</div>
      ) : photos.length === 0 ? (
        <button type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-md text-[12px] font-semibold transition-colors"
          style={{
            border: '1.5px dashed #8b5cf6',
            background: 'rgba(255,255,255,0.45)',
            color: '#6b21a8',
            cursor: uploading ? 'wait' : 'pointer',
          }}>
          <Upload size={12} /> Upload the first handoff photo
        </button>
      ) : (
        <div className="flex flex-wrap gap-2">
          {photos.map(p => (
            <button key={p.id}
              type="button"
              onClick={() => setPreview(p)}
              className="rounded-md overflow-hidden hover:opacity-90 transition-opacity"
              style={{ width: 72, height: 72, background: '#ede9fe', border: '1px solid #ddd6fe' }}>
              {p.signedUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={p.signedUrl} alt={p.fileName}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              ) : (
                <span className="text-[10px]" style={{ color: '#6b21a8' }}>No URL</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Lightbox-style preview. Web pattern matches dispatch's existing
          full-screen photo viewer in the document panels. */}
      {preview && (
        <div
          onClick={() => setPreview(null)}
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.92)' }}>
          <div className="absolute top-4 right-4 flex items-center gap-2">
            {preview.signedUrl && (
              <a href={preview.signedUrl} target="_blank" rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
                style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
                <ExternalLink size={12} /> Open
              </a>
            )}
            <button type="button"
              onClick={(e) => { e.stopPropagation(); void handleDelete(preview); setPreview(null); }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5"
              style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
              <Trash2 size={12} /> Delete
            </button>
            <button type="button" onClick={() => setPreview(null)}
              className="p-1.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
              <X size={16} />
            </button>
          </div>
          {preview.signedUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview.signedUrl} alt={preview.fileName}
              onClick={e => e.stopPropagation()}
              style={{ maxWidth: '90vw', maxHeight: '90vh', objectFit: 'contain' }} />
          )}
        </div>
      )}
    </div>
  );
}

// Compact title-row marker for the relay banner. Just shows "Handoff
// photos: N" with an icon — for use in headers/summaries where the
// full grid would be too noisy.
export function RelayHandoffPhotosCount({ loadId }: { loadId: string }) {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await railway.listLoadDocuments(loadId);
        if (!alive) return;
        setCount((res.documents ?? []).filter(d => d.kind === 'relay_handoff').length);
      } catch { /* */ }
    })();
    return () => { alive = false; };
  }, [loadId]);
  if (count == null || count === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-semibold"
      style={{ color: '#6b21a8' }}>
      <ArrowLeftRight size={11} /> {count} handoff photo{count === 1 ? '' : 's'}
    </span>
  );
}
