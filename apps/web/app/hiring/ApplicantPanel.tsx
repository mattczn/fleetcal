'use client';

/**
 * The expanded row on /hiring — everything the applicant sent, plus the
 * documents.
 *
 * The MVR is the reason this exists. A carrier orders it after the applicant
 * signs the authorization on the website, and until now the resulting PDF had
 * nowhere to live: the applicant isn't a driver yet, so the driver profile's
 * document tab can't hold it. These uploads write to the same
 * `driver_documents` table the driver profile reads, with a null driver_id
 * that gets filled in at hire time — so the CDL photo from the website and
 * the MVR someone pulled by hand both follow the person onto their driver
 * record without a copy step.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Loader2, Upload, Trash2, FileText, ShieldCheck, Globe, ExternalLink,
} from 'lucide-react';
import {
  railway,
  type HiringApplicant,
  type ApplicantDocument,
  type ApplicantDocumentKind,
} from '@/lib/railway';

const KIND_LABEL: Record<ApplicantDocumentKind, string> = {
  license: 'CDL',
  medical_card: 'Medical card',
  mvr: 'MVR',
  other: 'Other',
};

/** Upload targets, in the order someone collects them. */
const UPLOAD_KINDS: ApplicantDocumentKind[] = ['mvr', 'license', 'medical_card', 'other'];

function fileSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-muted)' }}>
        {label}
      </div>
      <div className="mt-0.5 text-sm" style={{ color: 'var(--gc-text)' }}>{value || '—'}</div>
    </div>
  );
}

export default function ApplicantPanel({ applicant }: { applicant: HiringApplicant }) {
  const [documents, setDocuments] = useState<ApplicantDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState<ApplicantDocumentKind | null>(null);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pendingKind = useRef<ApplicantDocumentKind>('mvr');

  const load = useCallback(async () => {
    try {
      const { documents: rows } = await railway.listApplicantDocuments(applicant.id);
      setDocuments(rows);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load documents.');
    } finally {
      setLoading(false);
    }
  }, [applicant.id]);

  useEffect(() => { void load(); }, [load]);

  function pick(kind: ApplicantDocumentKind) {
    pendingKind.current = kind;
    inputRef.current?.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change.
    e.target.value = '';
    if (!file) return;

    const kind = pendingKind.current;
    setUploading(kind);
    setError('');
    try {
      await railway.uploadApplicantDocument(applicant.id, file, kind);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(null);
    }
  }

  async function handleDelete(doc: ApplicantDocument) {
    if (!confirm(`Delete ${doc.fileName}? This removes the file permanently.`)) return;
    setError('');
    try {
      await railway.deleteApplicantDocument(applicant.id, doc.id);
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete that document.');
    }
  }

  const address = [
    applicant.address_line1,
    applicant.address_line2,
    [applicant.city, applicant.state].filter(Boolean).join(', '),
    applicant.postal_code,
  ].filter(Boolean).join(' · ');

  return (
    <div className="grid gap-6 px-4 py-5 lg:grid-cols-2" style={{ background: 'var(--gc-surface-2, #f8fafc)' }}>
      <input ref={inputRef} type="file" hidden onChange={handleFile}
             accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" />

      {/* ── What they submitted ─────────────────────────────────────────── */}
      <section>
        <h3 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide"
            style={{ color: 'var(--gc-text-muted)' }}>
          Application
          {applicant.source === 'website' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-700">
              <Globe className="h-3 w-3" /> From the website
            </span>
          )}
        </h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Detail label="License" value={
            [applicant.cdl_class && `Class ${applicant.cdl_class}`, applicant.license_number,
             applicant.license_state].filter(Boolean).join(' · ')} />
          <Detail label="Date of birth" value={applicant.dob} />
          <Detail label="Address" value={address} />
          <Detail label="Applied" value={new Date(applicant.created_at).toLocaleDateString()} />
        </div>

        {applicant.experience && (
          <div className="mt-4">
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-muted)' }}>
              Employers &amp; experience
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--gc-text)' }}>
              {applicant.experience}
            </p>
          </div>
        )}

        {/* The authorization is what permits ordering the MVR, so it's shown
            as a record — who signed, when, from where — not a checkmark. */}
        {applicant.consent_signature && (
          <div className="mt-4 rounded-lg border p-3"
               style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-emerald-700">
              <ShieldCheck className="h-3.5 w-3.5" />
              Background / MVR authorization signed
            </div>
            <div className="mt-2 text-sm" style={{ color: 'var(--gc-text)' }}>
              {applicant.consent_signature}
            </div>
            <div className="mt-1 text-xs" style={{ color: 'var(--gc-text-muted)' }}>
              {applicant.consent_signed_at && new Date(applicant.consent_signed_at).toLocaleString()}
              {applicant.consent_ip ? ` · IP ${applicant.consent_ip}` : ''}
            </div>
            <ul className="mt-2 space-y-0.5 text-xs" style={{ color: 'var(--gc-text-muted)' }}>
              {applicant.consent_records && <li>✓ Driving record and consumer report</li>}
              {applicant.consent_employers && <li>✓ Previous-employer safety and drug/alcohol history</li>}
              {applicant.certified && <li>✓ Certified the application is true and complete</li>}
            </ul>
          </div>
        )}
      </section>

      {/* ── Documents ───────────────────────────────────────────────────── */}
      <section>
        <h3 className="mb-3 text-xs font-bold uppercase tracking-wide" style={{ color: 'var(--gc-text-muted)' }}>
          Documents
        </h3>

        <div className="mb-3 flex flex-wrap gap-2">
          {UPLOAD_KINDS.map((kind) => (
            <button
              key={kind}
              onClick={() => pick(kind)}
              disabled={uploading !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
              style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text)', background: 'var(--gc-surface)' }}
            >
              {uploading === kind
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Upload className="h-3.5 w-3.5" />}
              Upload {KIND_LABEL[kind]}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        {loading && <Loader2 className="h-4 w-4 animate-spin" style={{ color: 'var(--gc-text-muted)' }} />}

        {!loading && !documents.length && (
          <p className="text-sm" style={{ color: 'var(--gc-text-muted)' }}>
            Nothing on file yet. Website applications arrive with the CDL and medical card attached.
          </p>
        )}

        <ul className="space-y-2">
          {documents.map((doc) => (
            <li key={doc.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--gc-border)', background: 'var(--gc-surface)' }}>
              <FileText className="h-4 w-4 shrink-0" style={{ color: 'var(--gc-text-muted)' }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold" style={{ color: 'var(--gc-text)' }}>
                  {doc.notes || KIND_LABEL[doc.kind]}
                </div>
                <div className="truncate text-xs" style={{ color: 'var(--gc-text-muted)' }}>
                  {doc.fileName} · {fileSize(doc.sizeBytes)} ·{' '}
                  {new Date(doc.uploadedAt).toLocaleDateString()}
                  {doc.onDriver ? ' · on driver profile' : ''}
                </div>
              </div>
              {doc.url && (
                <a href={doc.url} target="_blank" rel="noopener noreferrer"
                   className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-semibold"
                   style={{ borderColor: 'var(--gc-border)', color: 'var(--gc-text)' }}>
                  <ExternalLink className="h-3 w-3" /> View
                </a>
              )}
              <button onClick={() => handleDelete(doc)} title="Delete"
                      className="rounded-lg border p-1.5"
                      style={{ borderColor: 'var(--gc-border)', color: '#b91c1c' }}>
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
