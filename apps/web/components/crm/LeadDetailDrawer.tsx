'use client';

/**
 * LeadDetailDrawer — right-side detail panel for one CRM lead.
 *
 * Opened by row click on /crm. Fetches GET /v1/crm/leads/:id on mount
 * (lead + newest-first activities), then renders:
 *
 *   - contact card (email / phone / cell — editable, PATCH on save)
 *   - address block
 *   - fleet facts (PU, drivers, operation class, radius counts)
 *   - FMCSA facts (DOT#, MCS-150 date, add date)
 *   - status dropdown (all CRM_LEAD_STATUSES; PATCH on change)
 *   - notes composer (POST /activities kind=note)
 *   - activity timeline (kind icon + body/meta + relative time)
 *
 * Overlay + panel styling follows the app's modal conventions
 * (InternalNotesModal): rgba backdrop that closes on click, surface
 * panel with stopPropagation, gc-* tokens throughout.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  X, Loader2, Mail, MailWarning, MailCheck, Phone, MessageSquare,
  ArrowRightLeft, ListPlus, ListX, BellOff, Cog, MapPin, Truck, Landmark, Send,
} from 'lucide-react';
import type { CrmActivity, CrmActivityKind, CrmLead, CrmLeadStatus, CrmSequence } from '@fleetcal/types';
import { CRM_LEAD_STATUSES, SEND_BLOCKED_STATUSES } from '@fleetcal/types';
import { railway, RailwayError } from '@/lib/railway';
import { StyledSelect } from '@/components/ui/StyledSelect';
import { STATUS_META, StatusChip, OPERATION_CLASS_LABELS, isLocalLead, fmtRelativeTime } from './crmMeta';

interface Props {
  leadId: string;
  onClose: () => void;
  /** Fired after any successful PATCH so the list page can update its
   *  row (status chip, email icon) without a full refetch. */
  onLeadUpdated?: (lead: CrmLead) => void;
}

const ACTIVITY_ICON: Record<CrmActivityKind, React.ComponentType<{ size?: number; style?: React.CSSProperties }>> = {
  note:          MessageSquare,
  status_change: ArrowRightLeft,
  email_sent:    Mail,
  email_bounced: MailWarning,
  email_replied: MailCheck,
  call:          Phone,
  enrolled:      ListPlus,
  unenrolled:    ListX,
  unsubscribed:  BellOff,
  system:        Cog,
};

const inputStyle: React.CSSProperties = {
  background: 'var(--gc-bg)',
  border:     '1px solid var(--gc-border-light)',
  color:      'var(--gc-text-1)',
};

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function LeadDetailDrawer({ leadId, onClose, onLeadUpdated }: Props) {
  const [lead,       setLead]       = useState<CrmLead | null>(null);
  const [activities, setActivities] = useState<CrmActivity[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  // Contact edit state — initialized from the fetched lead; a Save
  // button appears when any field differs from the server value.
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [cell,  setCell]  = useState('');
  const [contactSaving, setContactSaving] = useState(false);

  const [statusSaving, setStatusSaving] = useState(false);
  const [noteText,     setNoteText]     = useState('');
  const [noteSaving,   setNoteSaving]   = useState(false);

  // ── Outreach (Phase 2) state ────────────────────────────────────────
  const [sequences,     setSequences]     = useState<CrmSequence[]>([]);
  const [selectedSeqId, setSelectedSeqId] = useState('');
  const [enrolling,     setEnrolling]     = useState(false);
  const [outreachMsg,   setOutreachMsg]   = useState<string | null>(null);
  const [markingReplied, setMarkingReplied] = useState(false);

  const refetch = useCallback(async (): Promise<CrmLead | null> => {
    try {
      const res = await railway.crmGetLead(leadId);
      setLead(res.lead);
      setActivities(res.activities);
      setEmail(res.lead.email ?? '');
      setPhone(res.lead.phone ?? '');
      setCell(res.lead.cellPhone ?? '');
      setError(null);
      return res.lead;
    } catch (e) {
      setError(e instanceof RailwayError ? `Failed to load lead (${e.status})` : 'Failed to load lead.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { void refetch(); }, [refetch]);

  // Active sequences for the enroll picker (fire-and-forget; the
  // section shows a hint if the list is empty or the fetch fails).
  useEffect(() => {
    let cancelled = false;
    railway.crmListSequences()
      .then(res => { if (!cancelled) setSequences(res.sequences.filter(s => s.isActive)); })
      .catch(() => { /* picker just stays empty */ });
    return () => { cancelled = true; };
  }, []);

  // Esc closes — matches the app's modal affordances.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const contactDirty = lead != null && (
    email.trim() !== (lead.email ?? '') ||
    phone.trim() !== (lead.phone ?? '') ||
    cell.trim()  !== (lead.cellPhone ?? '')
  );

  async function saveContact() {
    if (!lead || !contactDirty || contactSaving) return;
    setContactSaving(true);
    try {
      // Always send all three keys — the API treats "key in body" as
      // "edit this field" and maps '' → null, so an emptied input
      // clears the stored value.
      const res = await railway.crmPatchLead(lead.id, {
        email:     email.trim(),
        phone:     phone.trim(),
        cellPhone: cell.trim(),
      });
      setLead(res.lead);
      setEmail(res.lead.email ?? '');
      setPhone(res.lead.phone ?? '');
      setCell(res.lead.cellPhone ?? '');
      onLeadUpdated?.(res.lead);
    } catch {
      setError('Failed to save contact info.');
    } finally {
      setContactSaving(false);
    }
  }

  async function changeStatus(next: CrmLeadStatus) {
    if (!lead || next === lead.status || statusSaving) return;
    setStatusSaving(true);
    try {
      const res = await railway.crmPatchLead(lead.id, { status: next });
      setLead(res.lead);
      onLeadUpdated?.(res.lead);
      // Refetch to pull the server-written status_change activity.
      void refetch();
    } catch {
      setError('Failed to change status.');
    } finally {
      setStatusSaving(false);
    }
  }

  async function enroll() {
    if (!lead || !selectedSeqId || enrolling) return;
    setEnrolling(true);
    setOutreachMsg(null);
    try {
      await railway.crmEnroll(lead.id, selectedSeqId);
      setOutreachMsg('Enrolled.');
      setSelectedSeqId('');
      // Refetch pulls the server-written `enrolled` activity + the
      // new/enriched → queued status bump.
      const next = await refetch();
      if (next) onLeadUpdated?.(next);
    } catch (e) {
      const detail = e instanceof RailwayError && e.detail && typeof e.detail === 'object'
        ? (e.detail as { error?: string }).error
        : undefined;
      setOutreachMsg(
        detail === 'already_enrolled'   ? 'Already enrolled in this sequence.'
        : detail === 'lead_blocked'     ? 'Lead status blocks outreach.'
        : detail === 'lead_has_no_email' ? 'Lead has no email on file.'
        : 'Enroll failed.',
      );
    } finally {
      setEnrolling(false);
    }
  }

  async function markReplied() {
    if (!lead || markingReplied) return;
    setMarkingReplied(true);
    setOutreachMsg(null);
    try {
      await railway.crmMarkReplied(lead.id);
      setOutreachMsg('Marked replied — sequences stopped.');
      const next = await refetch();
      if (next) onLeadUpdated?.(next);
    } catch {
      setOutreachMsg('Failed to mark replied.');
    } finally {
      setMarkingReplied(false);
    }
  }

  async function addNote() {
    const trimmed = noteText.trim();
    if (!lead || !trimmed || noteSaving) return;
    setNoteSaving(true);
    try {
      const res = await railway.crmAddNote(lead.id, trimmed);
      setActivities(prev => [res.activity, ...prev]);
      setNoteText('');
    } catch {
      setError('Failed to add note.');
    } finally {
      setNoteSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 flex justify-end"
      style={{ background: 'rgba(0,0,0,0.3)', zIndex: 60 }}
      onClick={onClose}>
      <div className="h-full w-[480px] max-w-[94vw] flex flex-col"
        style={{ background: 'var(--gc-surface)', boxShadow: '-8px 0 32px rgba(0,0,0,0.16)' }}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4"
          style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="min-w-0">
            <div className="text-[15px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
              {lead?.legalName ?? 'Lead'}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              {lead?.dbaName && <span className="truncate">DBA {lead.dbaName}</span>}
              {lead?.dotNumber != null && <span className="tabular-nums">DOT #{lead.dotNumber}</span>}
              {lead && isLocalLead(lead) && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-extrabold"
                  style={{ background: '#e6f4ea', color: '#188038' }}>
                  Local
                </span>
              )}
              {lead && <StatusChip status={lead.status} />}
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-[var(--gc-hover)] shrink-0" title="Close">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {loading ? (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={18} className="animate-spin" />
            </div>
          ) : !lead ? (
            <div className="rounded-xl p-3 text-[13px]" style={{ background: '#fee2e2', color: '#991b1b' }}>
              {error ?? 'Lead not found.'}
            </div>
          ) : (
            <>
              {error && (
                <div className="rounded-xl p-3 text-[13px]" style={{ background: '#fee2e2', color: '#991b1b' }}>
                  {error}
                </div>
              )}

              {/* Status */}
              <Section title="Status">
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <StyledSelect
                      value={lead.status}
                      disabled={statusSaving}
                      onChange={e => void changeStatus(e.target.value as CrmLeadStatus)}
                      style={{
                        ...inputStyle,
                        width: '100%', borderRadius: 8, padding: '7px 10px',
                        fontSize: 13, fontWeight: 600,
                      }}>
                      {CRM_LEAD_STATUSES.map(s => (
                        <option key={s} value={s}>{STATUS_META[s].label}</option>
                      ))}
                    </StyledSelect>
                  </div>
                  {statusSaving && <Loader2 size={14} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
                </div>
                <div className="text-[11px] mt-1.5" style={{ color: 'var(--gc-text-3)' }}>
                  Changed {fmtRelativeTime(lead.statusChangedAt)}
                </div>
              </Section>

              {/* Contact */}
              <Section title="Contact" icon={Mail}>
                <div className="flex flex-col gap-2">
                  <LabeledInput label="Email" type="email" value={email} onChange={setEmail} placeholder="none on file" />
                  <LabeledInput label="Phone" type="tel" value={phone} onChange={setPhone} placeholder="none on file" />
                  <LabeledInput label="Cell"  type="tel" value={cell}  onChange={setCell}  placeholder="none on file" />
                  {contactDirty && (
                    <div className="flex justify-end">
                      <button onClick={() => void saveContact()} disabled={contactSaving}
                        className="text-[12px] font-semibold px-3.5 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                        style={{ background: '#1a73e8', color: '#fff' }}>
                        {contactSaving ? 'Saving…' : 'Save contact'}
                      </button>
                    </div>
                  )}
                </div>
              </Section>

              {/* Outreach (Phase 2) — enroll picker + mark replied. */}
              <Section title="Outreach" icon={Send}>
                {(() => {
                  const blocked = (SEND_BLOCKED_STATUSES as readonly CrmLeadStatus[]).includes(lead.status);
                  const noEmail = !lead.email;
                  const disabled = blocked || noEmail;
                  return (
                    <div className="flex flex-col gap-2">
                      {sequences.length === 0 ? (
                        <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
                          No active sequences.{' '}
                          <Link href="/crm/sequences" style={{ color: '#1a73e8', textDecoration: 'none', fontWeight: 600 }}>
                            Create one →
                          </Link>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 min-w-0">
                            <StyledSelect
                              value={selectedSeqId}
                              disabled={disabled || enrolling}
                              onChange={e => setSelectedSeqId(e.target.value)}
                              style={{
                                ...inputStyle,
                                width: '100%', borderRadius: 8, padding: '7px 10px', fontSize: 13,
                                opacity: disabled ? 0.6 : 1,
                              }}>
                              <option value="">Enroll in a sequence…</option>
                              {sequences.map(s => (
                                <option key={s.id} value={s.id}>
                                  {s.name} ({s.steps.length} step{s.steps.length === 1 ? '' : 's'})
                                </option>
                              ))}
                            </StyledSelect>
                          </div>
                          <button onClick={() => void enroll()}
                            disabled={disabled || !selectedSeqId || enrolling}
                            className="text-[12px] font-semibold px-3.5 py-1.5 rounded-lg transition-opacity disabled:opacity-40 shrink-0"
                            style={{ background: '#1a73e8', color: '#fff' }}>
                            {enrolling ? 'Enrolling…' : 'Enroll'}
                          </button>
                        </div>
                      )}
                      {disabled && (
                        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          {blocked
                            ? `Enrollment is blocked while the lead is ${STATUS_META[lead.status].label.toLowerCase()}.`
                            : 'Add an email address above to enroll this lead.'}
                        </div>
                      )}
                      {outreachMsg && (
                        <div className="text-[12px] font-semibold"
                          style={{ color: outreachMsg === 'Enrolled.' || outreachMsg.startsWith('Marked replied') ? '#188038' : '#c5221f' }}>
                          {outreachMsg}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-2 pt-1"
                        style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 8 }}>
                        <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          Replied off-thread? Stops sequences, cancels queued sends, moves to Interested.
                        </span>
                        <button onClick={() => void markReplied()} disabled={markingReplied}
                          className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-50 shrink-0"
                          style={{ background: '#e0f7fa', color: '#00838f' }}>
                          {markingReplied ? <Loader2 size={11} className="animate-spin" /> : <MailCheck size={11} />}
                          Mark replied
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </Section>

              {/* Address */}
              <Section title="Address" icon={MapPin}>
                <div className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>
                  {lead.phyStreet && <div>{lead.phyStreet}</div>}
                  <div>
                    {[lead.phyCity, lead.phyState].filter(Boolean).join(', ')}
                    {lead.phyZip ? ` ${lead.phyZip}` : ''}
                  </div>
                  {!lead.phyStreet && !lead.phyCity && !lead.phyState && (
                    <span style={{ color: 'var(--gc-text-3)' }}>No address on file.</span>
                  )}
                </div>
              </Section>

              {/* Fleet facts */}
              <Section title="Fleet" icon={Truck}>
                <FactGrid facts={[
                  ['Power units',   lead.powerUnits   != null ? String(lead.powerUnits)   : '—'],
                  ['Drivers',       lead.totalDrivers != null ? String(lead.totalDrivers) : '—'],
                  ['Operation',     lead.carrierOperation
                    ? `${lead.carrierOperation} — ${OPERATION_CLASS_LABELS[lead.carrierOperation] ?? 'Unknown'}`
                    : '—'],
                  ['Hazmat',        lead.hmInd == null ? '—' : lead.hmInd ? 'Yes' : 'No'],
                  ['Within 100mi',  String((lead.interstateWithin100 ?? 0) + (lead.intrastateWithin100 ?? 0)) + ' drivers'],
                  ['Beyond 100mi',  String((lead.interstateBeyond100 ?? 0) + (lead.intrastateBeyond100 ?? 0)) + ' drivers'],
                ]} />
              </Section>

              {/* FMCSA facts */}
              <Section title="FMCSA" icon={Landmark}>
                <FactGrid facts={[
                  ['DOT number',   lead.dotNumber != null ? `#${lead.dotNumber}` : '—'],
                  ['MCS-150 date', fmtDate(lead.mcs150Date)],
                  ['Add date',     fmtDate(lead.fmcsaAddDate)],
                  ['Source',       lead.source === 'fmcsa_census' ? 'FMCSA census' : 'Manual'],
                  ['Ingested',     fmtDate(lead.createdAt)],
                  ['Call attempts', String(lead.callAttempts)],
                ]} />
              </Section>

              {/* Notes composer */}
              <Section title="Add note" icon={MessageSquare}>
                <textarea
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void addNote();
                    }
                  }}
                  rows={3}
                  placeholder="Add a note for the team…"
                  className="w-full rounded-lg px-3 py-2 text-[13px] outline-none resize-none"
                  style={inputStyle}
                />
                <div className="flex items-center justify-between mt-2">
                  <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>
                    ⌘/Ctrl+Enter to send
                  </div>
                  <button onClick={() => void addNote()}
                    disabled={!noteText.trim() || noteSaving}
                    className="text-[12px] font-semibold px-3.5 py-1.5 rounded-lg transition-opacity"
                    style={{
                      background: '#1a73e8',
                      color:      '#fff',
                      opacity:    !noteText.trim() || noteSaving ? 0.4 : 1,
                      cursor:     !noteText.trim() || noteSaving ? 'not-allowed' : 'pointer',
                    }}>
                    {noteSaving ? 'Saving…' : 'Add note'}
                  </button>
                </div>
              </Section>

              {/* Activity timeline — server returns newest first. */}
              <Section title={`Activity (${activities.length})`}>
                {activities.length === 0 ? (
                  <div className="text-[13px] italic py-4 text-center" style={{ color: 'var(--gc-text-3)' }}>
                    No activity yet.
                  </div>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {activities.map(a => <ActivityRow key={a.id} activity={a} />)}
                  </ul>
                )}
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

function Section({
  title, icon: Icon, children,
}: {
  title: string;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl px-4 py-3"
      style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
      <div className="flex items-center gap-1.5 mb-2">
        {Icon && <Icon size={12} style={{ color: 'var(--gc-text-3)' }} />}
        <span className="text-[10.5px] font-extrabold uppercase tracking-wider" style={{ color: 'var(--gc-text-2)' }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function LabeledInput({
  label, value, onChange, type, placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type: string;
  placeholder?: string;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[11.5px] font-semibold w-12 shrink-0" style={{ color: 'var(--gc-text-3)' }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="flex-1 min-w-0 rounded-lg px-2.5 py-1.5 text-[13px] outline-none"
        style={inputStyle}
      />
    </label>
  );
}

function FactGrid({ facts }: { facts: Array<[string, string]> }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2">
      {facts.map(([k, v]) => (
        <div key={k}>
          <div className="text-[10.5px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>{k}</div>
          <div className="text-[13px] font-medium tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function ActivityRow({ activity }: { activity: CrmActivity }) {
  const Icon = ACTIVITY_ICON[activity.kind] ?? Cog;
  // status_change carries { from, to } in meta; render it as the body.
  const meta = activity.meta as { from?: string; to?: string } | undefined;
  const body = activity.body
    ?? (activity.kind === 'status_change' && meta?.from && meta?.to
      ? `${STATUS_META[meta.from as CrmLeadStatus]?.label ?? meta.from} → ${STATUS_META[meta.to as CrmLeadStatus]?.label ?? meta.to}`
      : activity.kind.replaceAll('_', ' '));
  return (
    <li className="flex items-start gap-2.5 rounded-lg px-2.5 py-2"
      style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <span className="shrink-0 grid place-items-center rounded-md"
        style={{ width: 24, height: 24, background: 'var(--gc-bg)' }}>
        <Icon size={12} style={{ color: 'var(--gc-text-2)' }} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] whitespace-pre-wrap break-words" style={{ color: 'var(--gc-text-1)' }}>
          {body}
        </div>
        <div className="text-[10.5px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
          {fmtRelativeTime(activity.createdAt)}
          {activity.actorUserId ? '' : ' · system'}
        </div>
      </div>
    </li>
  );
}
