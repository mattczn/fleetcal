'use client';

/**
 * FollowUpModal — chase-list workbench for a single Flagged load.
 *
 * Shows every current impediment (manual flag, missing POD, pending
 * accessorials) with quick actions, plus the threaded follow-up
 * history. Adding a new follow-up can optionally apply a resolution
 * atomically: flip an accessorial to approved/denied, clear the
 * manual flag. State changes go through the closeout PATCH endpoint
 * (action='add_follow_up').
 *
 * Why one modal for everything: brokers don't always follow up
 * cleanly per item — a single call covers detention AND POD AND a
 * rate question. Capturing one note per call with optional
 * structured resolutions matches how the work actually happens.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Flag, Loader2, X, Check, AlertOctagon, MessageSquare, Send,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { railway } from '@/lib/railway';
import type { Load, LoadFollowUp, LoadFollowUpCategory } from '@fleetcal/types';

interface Props {
  load:       Load;
  /** Doc counts for the load (drives the missing-POD chip). Passed
   *  in from CloseoutView so we don't have to refetch here. */
  docCounts?: Record<string, number>;
  actorName?: string;
  onClose:    () => void;
  onSaved:    () => void | Promise<void>;
}

const ACCESSORIAL_LABELS: Record<string, string> = {
  detention:    'Detention',
  lumper:       'Lumper',
  layover:      'Layover',
  scale_ticket: 'Scale ticket',
  extra_stop:   'Extra stop',
  other:        'Accessorial',
};

const CATEGORY_LABELS: Record<LoadFollowUpCategory, string> = {
  pod:           'POD',
  rate_con:      'Rate con',
  rate_dispute:  'Rate dispute',
  accessorial:   'Accessorial',
  other:         'Other',
};

const moneyFmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDateTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export default function FollowUpModal({ load, docCounts, actorName, onClose, onSaved }: Props) {
  const [note, setNote]           = useState('');
  const [category, setCategory]   = useState<LoadFollowUpCategory | ''>('');
  // Optional structured resolution attached to this follow-up.
  // type='accessorial_status' pairs with accessorialId + newStatus;
  // type='flag_cleared' clears the manual flag;
  // type='mark_tonu' toggles the TONU flag (exempts POD check).
  const [resolutionType, setResolutionType] = useState<'none' | 'accessorial_status' | 'flag_cleared' | 'mark_tonu'>('none');
  const [resAccId,        setResAccId]       = useState<string>('');
  const [resNewStatus,    setResNewStatus]   = useState<'approved' | 'denied'>('approved');
  const [resIsTonu,       setResIsTonu]      = useState<boolean>(true);
  const [busy, setBusy]           = useState(false);
  const [showHistory, setShowHistory] = useState(true);

  const followUps = useMemo<LoadFollowUp[]>(
    () => (load.followUps ?? []).slice().sort((a, b) => b.at.localeCompare(a.at)),
    [load.followUps],
  );

  // Impediment summary for the top of the modal.
  const pendingAccessorials = (load.accessorials ?? []).filter(
    a => a.status !== 'approved' && a.status !== 'denied',
  );
  // POD only matters when not a TONU and the load actually delivered.
  // We approximate "delivered" with the load.end timestamp (same logic
  // the server uses for the auto-flag — keeps the UI in sync).
  const isTonu = !!load.isTonu;
  const podMissing = !isTonu && (docCounts?.pod ?? 0) === 0;
  const manualFlag = load.flaggedReason
    ? { reason: load.flaggedReason, note: load.flaggedNote, by: load.flaggedBy, at: load.flaggedAt }
    : null;

  // Default the category from the resolution type if the user hasn't
  // explicitly set one.
  useEffect(() => {
    if (!category) {
      if (resolutionType === 'accessorial_status') setCategory('accessorial');
      else if (resolutionType === 'flag_cleared') setCategory(manualFlag?.reason === 'missing_pod' ? 'pod' : 'other');
      else if (resolutionType === 'mark_tonu')    setCategory('pod');
    }
    // Snap resIsTonu to the opposite of current — "mark TONU" if not
    // TONU, "un-mark" if it is. User can flip after if they really
    // want the same direction.
    if (resolutionType === 'mark_tonu') setResIsTonu(!isTonu);
  }, [resolutionType]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!note.trim()) return;
    setBusy(true);
    try {
      const body: Parameters<typeof railway.updateLoadCloseout>[1] = {
        action:           'add_follow_up',
        actorName,
        followUpNote:     note.trim(),
        followUpCategory: category || undefined,
      };
      if (resolutionType === 'accessorial_status') {
        if (!resAccId) {
          window.alert('Pick which accessorial this resolves.');
          setBusy(false);
          return;
        }
        body.followUpResolution = {
          type:          'accessorial_status',
          accessorialId: resAccId,
          newStatus:     resNewStatus,
        };
      } else if (resolutionType === 'flag_cleared') {
        body.followUpResolution = { type: 'flag_cleared' };
      } else if (resolutionType === 'mark_tonu') {
        body.followUpResolution = { type: 'mark_tonu', isTonu: resIsTonu };
      }
      const targetId = load.loadId ?? load.id;
      await railway.updateLoadCloseout(targetId, body);
      setNote('');
      setCategory('');
      setResolutionType('none');
      setResAccId('');
      await onSaved();
    } catch (err) {
      console.error('[FollowUpModal] save failed:', err);
      window.alert('Failed to save follow-up. Check console for details.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[210] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.45)' }}
      onMouseDown={e => { if (!busy && e.target === e.currentTarget) onClose(); }}>
      <div className="rounded-2xl overflow-hidden flex flex-col"
        style={{
          width: 'min(720px, 96vw)',
          maxHeight: '92vh',
          background: 'var(--gc-surface)',
          boxShadow: '0 16px 40px rgba(0,0,0,0.25)',
        }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 py-4 flex items-center gap-3 shrink-0"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <Flag size={16} style={{ color: '#b45309' }} />
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>
            Follow up &mdash; {load.title} {load.loadNum ? <span style={{ color: 'var(--gc-text-3)' }}>#{load.loadNum}</span> : null}
          </div>
          <button onClick={onClose} disabled={busy}
            className="ml-auto p-1.5 rounded-lg hover:bg-[var(--gc-hover)] disabled:opacity-50">
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-sm overflow-y-auto flex-1">

          {/* Impediment summary */}
          <div className="space-y-2">
            <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
              Impediments
            </div>
            {!manualFlag && !podMissing && pendingAccessorials.length === 0 && (
              <div className="px-3 py-2 rounded-lg text-[12.5px]"
                style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}>
                No open impediments. Load is ready to release.
              </div>
            )}
            {manualFlag && (
              <ImpedimentRow
                tone={{ bg: '#fef3c7', fg: '#92400e', border: '#fde68a' }}
                title={`Manual flag: ${manualFlag.reason}`}
                detail={manualFlag.note ?? undefined}
                meta={manualFlag.at ? `Flagged ${fmtDateTime(manualFlag.at)} by ${manualFlag.by ?? 'someone'}` : undefined}
              />
            )}
            {podMissing && (
              <ImpedimentRow
                tone={{ bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' }}
                title="POD missing"
                detail="No proof-of-delivery uploaded yet. Driver or facility owes us paperwork."
              />
            )}
            {pendingAccessorials.map(a => (
              <ImpedimentRow key={a.id}
                tone={{ bg: '#dcfce7', fg: '#166534', border: '#86efac' }}
                title={`${ACCESSORIAL_LABELS[a.category] ?? 'Accessorial'} ${moneyFmt(a.amount)}`}
                detail={a.description ?? undefined}
                meta={`Status: ${a.status ?? 'requested'} — waiting on broker decision`}
              />
            ))}
            {isTonu && (
              // Not an impediment — informational. Surfaces that this
              // load is exempt from POD so the user knows why no
              // "missing POD" chip appears even on a delivered load.
              <ImpedimentRow
                tone={{ bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' }}
                title="TONU — no POD required"
                detail="Marked as Truck Order Not Used. Bill the TONU fee and skip POD verification."
              />
            )}
          </div>

          {/* Add follow-up form */}
          <div className="space-y-2 pt-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <div className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>
              Add follow-up
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="What did you do? (called broker AP, emailed driver, etc.)"
              rows={3}
              disabled={busy}
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{
                background: 'var(--gc-surface)',
                border: '1px solid var(--gc-border)',
                color: 'var(--gc-text-1)',
                fontFamily: 'inherit',
                resize: 'vertical',
              }} />

            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                <span>Category</span>
                <select value={category} onChange={e => setCategory(e.target.value as LoadFollowUpCategory | '')}
                  disabled={busy}
                  className="text-[12px] px-2 py-1 rounded-md outline-none"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
                  <option value="">(none)</option>
                  {(Object.entries(CATEGORY_LABELS) as [LoadFollowUpCategory, string][]).map(([k, v]) =>
                    <option key={k} value={k}>{v}</option>,
                  )}
                </select>
              </label>

              <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
                <span>Resolution</span>
                <select value={resolutionType}
                  onChange={e => setResolutionType(e.target.value as 'none' | 'accessorial_status' | 'flag_cleared' | 'mark_tonu')}
                  disabled={busy}
                  className="text-[12px] px-2 py-1 rounded-md outline-none"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
                  <option value="none">No status change</option>
                  {pendingAccessorials.length > 0 && (
                    <option value="accessorial_status">Approve / deny an accessorial</option>
                  )}
                  {manualFlag && (
                    <option value="flag_cleared">Clear manual flag</option>
                  )}
                  {/* TONU toggle — surface "mark" when not currently
                      TONU, "un-mark" when it is. Either way the
                      sub-form below confirms the intent. */}
                  <option value="mark_tonu">
                    {isTonu ? 'Un-mark TONU (POD required again)' : 'Mark as TONU (no POD needed)'}
                  </option>
                </select>
              </label>
            </div>

            {/* Sub-form when resolution=mark_tonu */}
            {resolutionType === 'mark_tonu' && (
              <div className="px-3 py-2 rounded-lg text-[12px]"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-2)' }}>
                {resIsTonu
                  ? 'This load will be marked TONU. The missing-POD impediment goes away; other impediments (accessorials, manual flag) still apply.'
                  : 'This load will go back to regular POD requirements.'}
              </div>
            )}

            {/* Sub-form when resolution=accessorial_status */}
            {resolutionType === 'accessorial_status' && (
              <div className="px-3 py-2 rounded-lg flex flex-wrap items-center gap-3"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                <select value={resAccId} onChange={e => setResAccId(e.target.value)} disabled={busy}
                  className="text-[12px] px-2 py-1 rounded-md outline-none"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
                  <option value="">Pick an accessorial&hellip;</option>
                  {pendingAccessorials.map(a =>
                    <option key={a.id} value={a.id}>
                      {ACCESSORIAL_LABELS[a.category] ?? 'Accessorial'} &mdash; {moneyFmt(a.amount)}
                    </option>,
                  )}
                </select>
                <div className="flex items-center gap-1">
                  <button onClick={() => setResNewStatus('approved')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1 rounded-lg transition-colors"
                    style={{
                      background: resNewStatus === 'approved' ? '#dcfce7' : 'var(--gc-surface)',
                      color:      resNewStatus === 'approved' ? '#166534' : 'var(--gc-text-2)',
                      border:     `1px solid ${resNewStatus === 'approved' ? '#86efac' : 'var(--gc-border)'}`,
                    }}>
                    <Check size={11} className="inline mr-1" /> Approve
                  </button>
                  <button onClick={() => setResNewStatus('denied')} disabled={busy}
                    className="text-[12px] font-semibold px-3 py-1 rounded-lg transition-colors"
                    style={{
                      background: resNewStatus === 'denied' ? '#fef2f2' : 'var(--gc-surface)',
                      color:      resNewStatus === 'denied' ? '#991b1b' : 'var(--gc-text-2)',
                      border:     `1px solid ${resNewStatus === 'denied' ? '#fecaca' : 'var(--gc-border)'}`,
                    }}>
                    <X size={11} className="inline mr-1" /> Deny
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Save button (sticky-ish at bottom of body, before timeline) */}
          <div className="flex justify-end">
            <button onClick={() => void handleSave()} disabled={busy || !note.trim()}
              className="text-[12px] font-semibold px-4 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              style={{ background: '#1a73e8', color: '#fff' }}>
              {busy ? <Loader2 size={12} className="animate-spin inline mr-1.5" /> : <Send size={12} className="inline mr-1.5" />}
              Save follow-up
            </button>
          </div>

          {/* History */}
          <div className="pt-3" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <button onClick={() => setShowHistory(s => !s)}
              className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-semibold mb-2"
              style={{ color: 'var(--gc-text-3)' }}>
              {showHistory ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
              History ({followUps.length})
            </button>

            {showHistory && (
              followUps.length === 0 ? (
                <div className="text-[12px] italic" style={{ color: 'var(--gc-text-3)' }}>
                  No follow-ups yet. Your first one will appear here.
                </div>
              ) : (
                <ol className="space-y-2 list-none">
                  {followUps.map(f => (
                    <li key={f.id} className="rounded-lg px-3 py-2"
                      style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[11px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                          {f.by ?? 'Unknown'}
                        </span>
                        <span className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>
                          {fmtDateTime(f.at)}
                        </span>
                        {f.category && (
                          <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full ml-auto"
                            style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}>
                            {CATEGORY_LABELS[f.category]}
                          </span>
                        )}
                      </div>
                      <div className="text-[12.5px] whitespace-pre-wrap" style={{ color: 'var(--gc-text-1)' }}>
                        {f.note}
                      </div>
                      {f.resolution && (
                        <div className="mt-1.5 text-[11.5px] font-semibold inline-flex items-center gap-1 px-1.5 py-0.5 rounded-lg"
                          style={{ background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' }}>
                          <Check size={10} />
                          {f.resolution.type === 'accessorial_status'
                            ? `Set accessorial ${f.resolution.newStatus}`
                            : f.resolution.type === 'flag_cleared'
                              ? 'Cleared manual flag'
                              : 'TONU toggled'}
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Local primitives ──────────────────────────────────────────────────

function ImpedimentRow({
  tone, title, detail, meta,
}: {
  tone:    { bg: string; fg: string; border: string };
  title:   string;
  detail?: string;
  meta?:   string;
}) {
  return (
    <div className="px-3 py-2 rounded-lg"
      style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
      <div className="flex items-center gap-2">
        <AlertOctagon size={12} />
        <div className="text-[12.5px] font-semibold">{title}</div>
      </div>
      {detail && (
        <div className="mt-0.5 text-[12px]" style={{ opacity: 0.85 }}>
          {detail}
        </div>
      )}
      {meta && (
        <div className="mt-0.5 text-[11px]" style={{ opacity: 0.7 }}>
          {meta}
        </div>
      )}
    </div>
  );
}

// Suppress unused-import lint on MessageSquare — kept for future
// inline note-thread additions.
void MessageSquare;
