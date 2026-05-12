/**
 * Relay handoff photos — inline button.
 *
 * Sits next to the "Relay point: ..." line in the EventModal's relay
 * block. Drivers leave handoff photos via the mobile app (trailer
 * location, paperwork); ops mostly reads them. The button:
 *   - 0 photos → "Upload Handoff Photo" → file picker, uploads with
 *     kind='relay_handoff'.
 *   - 1+ photos → "View Handoff Photos (N)" → opens the existing
 *     uploaded-docs side panel and selects the newest photo. The
 *     panel handles preview / download / delete.
 *
 * No gallery render here anymore — the side panel is the source of
 * truth for viewing.
 */
'use client';

import { useRef, useState } from 'react';
import { Upload, Loader2, Image as ImageIcon } from 'lucide-react';
import { railway } from '@/lib/railway';

interface PhotoLite {
  id: string;
  uploadedAt: string;
}

interface Props {
  loadId: string;
  photos: PhotoLite[];
  onSelectInPanel: (docId: string) => void;
  onUploaded: () => void | Promise<void>;
}

export function HandoffPhotosButton({ loadId, photos, onSelectInPanel, onUploaded }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        await railway.uploadLoadDocument(loadId, file, 'relay_handoff');
      }
      await onUploaded();
    } catch (err) {
      alert(`Upload failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const hasPhotos = photos.length > 0;

  function handleClick() {
    if (busy) return;
    if (hasPhotos) {
      // Sort newest-first and open the most recent photo.
      const sorted = [...photos].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
      onSelectInPanel(sorted[0]!.id);
    } else {
      inputRef.current?.click();
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={e => void handleFiles(e.target.files)}
        style={{ display: 'none' }}
      />
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors shrink-0"
        style={{
          background: hasPhotos ? '#fff' : '#6b21a8',
          color: hasPhotos ? '#6b21a8' : '#fff',
          border: hasPhotos ? '1px solid #c4b5fd' : '1px solid transparent',
          opacity: busy ? 0.7 : 1,
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy
          ? <><Loader2 size={11} className="animate-spin" /> Uploading…</>
          : hasPhotos
            ? <><ImageIcon size={11} /> View Handoff Photos ({photos.length})</>
            : <><Upload size={11} /> Upload Handoff Photo</>}
      </button>
    </>
  );
}
