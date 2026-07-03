'use client';

/**
 * /crm/outbox — Phase-2 CRM: the outreach approval queue.
 *
 * Same triple gate as /crm. Tabs per email status (Pending default).
 * Pending tab: one-click "Approve all N" (crm.manage; the API's
 * approve-batch with no ids) + per-row Cancel. Failed tab: per-row
 * Retry (crm.manage) + the Resend error text. Rows expand on click to
 * show the rendered body snapshot.
 *
 * No websockets — a Refresh button refetches the active tab. The daily
 * cap shown in the header comes from GET /v1/crm/settings.
 */

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Target, ArrowLeft, Loader2, RefreshCw, CheckCheck, RotateCcw, XCircle,
  ChevronDown, ChevronRight, Eye, EyeOff,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import RequireCap from '@/components/auth/RequireCap';
import RequireInternalOrg from '@/components/crm/RequireInternalOrg';
import { Th, Td, fmtShortDate } from '@/components/queue/QueueTablePrimitives';
import { usePermissions } from '@/lib/usePermissions';
import { railway, RailwayError } from '@/lib/railway';
import type { CrmEmail, CrmEmailStatus, CrmSettings } from '@fleetcal/types';

const PAGE_LIMIT = 200;

/** Tab order per the operator's workflow: what needs action first. */
const TAB_ORDER: CrmEmailStatus[] = [
  'pending_approval', 'approved', 'sent', 'failed', 'bounced', 'suppressed', 'cancelled',
];

const EMAIL_STATUS_META: Record<CrmEmailStatus, { label: string; tint: string; tintLight: string }> = {
  pending_approval: { label: 'Pending',    tint: '#e37400', tintLight: '#fef3e2' },
  approved:         { label: 'Approved',   tint: '#1a73e8', tintLight: '#e8f0fe' },
  sent:             { label: 'Sent',       tint: '#188038', tintLight: '#e6f4ea' },
  failed:           { label: 'Failed',     tint: '#c5221f', tintLight: '#fee2e2' },
  bounced:          { label: 'Bounced',    tint: '#9a3412', tintLight: '#fed7aa' },
  suppressed:       { label: 'Suppressed', tint: '#7b1fa2', tintLight: '#f3e8fd' },
  cancelled:        { label: 'Cancelled',  tint: '#5f6368', tintLight: '#f1f3f4' },
};

export default function CrmOutboxPage() {
  return (
    <RequireCap cap="crm.access" module="crm">
      <RequireInternalOrg>
        <CrmOutboxPageInner />
      </RequireInternalOrg>
    </RequireCap>
  );
}

function CrmOutboxPageInner() {
  const { can } = usePermissions();
  const canManage = can('crm.manage');

  const [tab,     setTab]     = useState<CrmEmailStatus>('pending_approval');
  const [emails,  setEmails]  = useState<CrmEmail[]>([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [settings, setSettings] = useState<CrmSettings | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [rowBusyId,  setRowBusyId]  = useState<string | null>(null);
  const [approving,  setApproving]  = useState(false);
  const [actionMsg,  setActionMsg]  = useState<string | null>(null);

  const fetchEmails = useCallback(async (status: CrmEmailStatus) => {
    setLoading(true);
    try {
      const res = await railway.crmListEmails({ status, limit: PAGE_LIMIT });
      setEmails(res.emails);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(e instanceof RailwayError ? `Failed to load outbox (${e.status})` : 'Failed to load outbox.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setExpandedId(null);
    setActionMsg(null);
    void fetchEmails(tab);
  }, [tab, fetchEmails]);

  useEffect(() => {
    railway.crmGetSettings()
      .then(res => setSettings(res.settings))
      .catch(() => { /* cap display is decorative */ });
  }, []);

  async function handleApproveAll() {
    if (!canManage || approving || total === 0) return;
    if (!window.confirm(`Approve all ${total.toLocaleString()} pending email${total === 1 ? '' : 's'}? They send during the next send window.`)) return;
    setApproving(true);
    setActionMsg(null);
    try {
      const { approved } = await railway.crmApproveBatch();
      setActionMsg(`Approved ${approved.toLocaleString()} email${approved === 1 ? '' : 's'}.`);
      void fetchEmails(tab);
    } catch (e) {
      setActionMsg(e instanceof RailwayError ? `Approve failed (${e.status})` : 'Approve failed.');
    } finally {
      setApproving(false);
    }
  }

  async function handleCancel(id: string) {
    if (rowBusyId) return;
    setRowBusyId(id);
    setActionMsg(null);
    try {
      await railway.crmCancelEmail(id);
      setEmails(prev => prev.filter(e => e.id !== id));
      setTotal(t => Math.max(0, t - 1));
    } catch (e) {
      setActionMsg(e instanceof RailwayError && e.status === 409
        ? 'Email is no longer cancellable.'
        : 'Cancel failed.');
    } finally {
      setRowBusyId(null);
    }
  }

  async function handleRetry(id: string) {
    if (!canManage || rowBusyId) return;
    setRowBusyId(id);
    setActionMsg(null);
    try {
      await railway.crmRetryEmail(id);
      setEmails(prev => prev.filter(e => e.id !== id));
      setTotal(t => Math.max(0, t - 1));
      setActionMsg('Requeued — sends on the next sweep.');
    } catch (e) {
      setActionMsg(e instanceof RailwayError && e.status === 409
        ? 'Email is no longer retryable.'
        : 'Retry failed.');
    } finally {
      setRowBusyId(null);
    }
  }

  const meta = EMAIL_STATUS_META[tab];
  const showCancel = tab === 'pending_approval' || tab === 'approved';
  const showRetry  = tab === 'failed' && canManage;
  const showError  = tab === 'failed' || tab === 'bounced' || tab === 'suppressed' || tab === 'cancelled';
  const showOpens  = tab === 'sent';
  const dateLabel  = tab === 'sent' || tab === 'bounced' ? 'Sent' : 'Created';
  const colCount   = 4 + (showError ? 1 : 0) + (showOpens ? 1 : 0) + (showCancel || showRetry ? 1 : 0);

  return (
    <AppShell title="CRM outbox" icon={Target} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">

        {/* Header row */}
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/crm"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium"
            style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
            <ArrowLeft size={13} /> Back to leads
          </Link>
          {settings && (
            <span className="text-[12px] font-medium px-2.5 py-1 rounded-lg tabular-nums"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-2)' }}>
              Daily cap: {settings.dailySendCap}
              {settings.autoSend && <span style={{ color: '#e37400' }}> · auto-send ON</span>}
            </span>
          )}
          <div className="flex-1" />
          {actionMsg && (
            <span className="text-[12px] font-semibold px-2.5 py-1 rounded-lg"
              style={actionMsg.startsWith('Approved') || actionMsg.startsWith('Requeued')
                ? { background: '#e6f4ea', color: '#188038' }
                : { background: '#fee2e2', color: '#991b1b' }}>
              {actionMsg}
            </span>
          )}
          <button onClick={() => void fetchEmails(tab)}
            className="inline-flex items-center gap-1.5 text-[12px] font-medium px-3 py-1.5 rounded-lg transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }}>
            <RefreshCw size={12} /> Refresh
          </button>
          {tab === 'pending_approval' && canManage && (
            <button onClick={() => void handleApproveAll()} disabled={approving || total === 0}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors disabled:opacity-60"
              style={{ background: '#1a73e8', color: '#fff' }}>
              {approving ? <Loader2 size={12} className="animate-spin" /> : <CheckCheck size={12} />}
              Approve all {total.toLocaleString()}
            </button>
          )}
        </div>

        {/* Status tabs */}
        <div className="flex items-center gap-2 flex-wrap">
          {TAB_ORDER.map(s => {
            const m = EMAIL_STATUS_META[s];
            const active = tab === s;
            return (
              <button key={s} onClick={() => setTab(s)}
                className="inline-flex items-center gap-2 transition-colors"
                style={{
                  height:       30,
                  padding:      '0 11px',
                  borderRadius: 999,
                  background:   active ? m.tint : 'var(--gc-surface)',
                  color:        active ? '#fff' : 'var(--gc-text-2)',
                  border:       active ? '1px solid transparent' : '1px solid var(--gc-border-light)',
                  fontSize:     12,
                  fontWeight:   700,
                  cursor:       'pointer',
                }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 999,
                  background: active ? '#fff' : m.tint, flex: 'none',
                }} />
                {m.label}
                {active && (
                  <span className="tabular-nums" style={{ fontWeight: 800 }}>
                    {loading ? '…' : total.toLocaleString()}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Table */}
        {error ? (
          <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
            {error}
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col rounded-xl overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
            <div className="flex-1 min-h-0 overflow-auto">
              <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
                <thead className="sticky top-0" style={{ background: 'var(--gc-surface)', zIndex: 2, boxShadow: '0 1px 0 var(--gc-border-light)' }}>
                  <tr>
                    <Th>Lead</Th>
                    <Th>To</Th>
                    <Th>Subject</Th>
                    {showError && <Th>Error</Th>}
                    {showOpens && <Th>Opens</Th>}
                    <Th>{dateLabel}</Th>
                    {(showCancel || showRetry) && <Th align="right">Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {loading && emails.length === 0 ? (
                    <tr>
                      <td colSpan={colCount} className="py-16 text-center" style={{ color: 'var(--gc-text-3)' }}>
                        <Loader2 size={18} className="animate-spin inline" />
                      </td>
                    </tr>
                  ) : emails.length === 0 ? (
                    <tr>
                      <td colSpan={colCount} className="py-16 text-center text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
                        No {meta.label.toLowerCase()} emails.
                      </td>
                    </tr>
                  ) : emails.map(em => {
                    const expanded = expandedId === em.id;
                    const busy = rowBusyId === em.id;
                    return (
                      <React.Fragment key={em.id}>
                        <tr
                          onClick={() => setExpandedId(prev => (prev === em.id ? null : em.id))}
                          className="cursor-pointer transition-colors hover:bg-[var(--gc-hover)]"
                          style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                          <Td>
                            <div className="flex items-center gap-1.5">
                              {expanded
                                ? <ChevronDown size={13} style={{ color: 'var(--gc-text-3)', flex: 'none' }} />
                                : <ChevronRight size={13} style={{ color: 'var(--gc-text-3)', flex: 'none' }} />}
                              <span className="font-semibold truncate max-w-[220px]" style={{ color: 'var(--gc-text-1)' }}>
                                {em.leadName ?? '—'}
                              </span>
                            </div>
                          </Td>
                          <Td>
                            <span className="truncate max-w-[220px] inline-block align-bottom" style={{ color: 'var(--gc-text-2)' }}>
                              {em.toEmail}
                            </span>
                          </Td>
                          <Td>
                            <span className="truncate max-w-[320px] inline-block align-bottom">
                              {em.subject}
                            </span>
                          </Td>
                          {showError && (
                            <Td>
                              <span className="truncate max-w-[240px] inline-block align-bottom text-[12px]"
                                style={{ color: '#c5221f' }}>
                                {em.error ?? '—'}
                              </span>
                            </Td>
                          )}
                          {showOpens && (
                            <Td>
                              <OpenIndicator email={em} />
                            </Td>
                          )}
                          <Td>
                            <span className="tabular-nums whitespace-nowrap" style={{ color: 'var(--gc-text-2)' }}>
                              {fmtShortDate(em.sentAt ?? em.createdAt)}
                            </span>
                          </Td>
                          {(showCancel || showRetry) && (
                            <Td align="right">
                              <div className="flex items-center justify-end gap-1.5">
                                {busy && <Loader2 size={12} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
                                {showRetry && (
                                  <button
                                    onClick={e => { e.stopPropagation(); void handleRetry(em.id); }}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                                    style={{ background: '#e8f0fe', color: '#1a73e8' }}>
                                    <RotateCcw size={11} /> Retry
                                  </button>
                                )}
                                {showCancel && (
                                  <button
                                    onClick={e => { e.stopPropagation(); void handleCancel(em.id); }}
                                    disabled={busy}
                                    className="inline-flex items-center gap-1 text-[11.5px] font-semibold px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50"
                                    style={{ background: '#fee2e2', color: '#c5221f' }}>
                                    <XCircle size={11} /> Cancel
                                  </button>
                                )}
                              </div>
                            </Td>
                          )}
                        </tr>
                        {expanded && (
                          <tr style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                            <td colSpan={colCount} className="px-4 py-3" style={{ background: 'var(--gc-bg)' }}>
                              <div className="text-[10.5px] font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>
                                Body (rendered snapshot)
                              </div>
                              <div className="text-[12.5px] whitespace-pre-wrap break-words max-w-[760px]"
                                style={{ color: 'var(--gc-text-1)' }}>
                                {em.body}
                              </div>
                              {em.error && (
                                <div className="text-[12px] mt-2 font-medium" style={{ color: '#c5221f' }}>
                                  Error: {em.error}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Footer count */}
            <div className="flex items-center justify-between px-3 py-2"
              style={{ borderTop: '1px solid var(--gc-border-light)' }}>
              <span className="text-[12px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                {total === 0
                  ? `No ${meta.label.toLowerCase()} emails`
                  : total > emails.length
                    ? `Showing newest ${emails.length.toLocaleString()} of ${total.toLocaleString()}`
                    : `${total.toLocaleString()} email${total === 1 ? '' : 's'}`}
                {loading && <Loader2 size={11} className="animate-spin inline ml-2" />}
              </span>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

/**
 * Show open activity for a sent email — count of opens + relative time
 * since the last one. Two important caveats surface in the tooltip:
 *  - Apple Mail Privacy Protection pre-loads tracking pixels silently
 *    on device open, so counts over-report ~30-40%. Treat as
 *    directional.
 *  - No pixel = no open registered (mail clients that block images,
 *    corporate filters, plain-text-preferring clients). Sends without
 *    an open indicator here haven't necessarily gone unread.
 * Neither breaks the signal — repeat opens, quick opens, or opens
 * followed by a click are real interest markers.
 */
function OpenIndicator({ email }: { email: CrmEmail }) {
  const count = email.openCount ?? 0;
  if (count === 0) {
    return (
      <span title="No opens tracked yet. Recipient hasn't loaded the tracking pixel — could be unread, could be a mail client blocking images."
        className="inline-flex items-center gap-1 text-[11.5px]"
        style={{ color: 'var(--gc-text-3)' }}>
        <EyeOff size={12} /> —
      </span>
    );
  }
  const last = email.lastOpenedAt ? new Date(email.lastOpenedAt) : null;
  const rel = last ? fmtRelTime(last) : '';
  return (
    <span title={`${count} open${count === 1 ? '' : 's'}${email.firstOpenedAt ? ` · first ${fmtRelTime(new Date(email.firstOpenedAt))}` : ''}${rel ? ` · last ${rel}` : ''}. Apple Mail Privacy Protection can over-report ~30-40%.`}
      className="inline-flex items-center gap-1 text-[11.5px] font-semibold"
      style={{ color: '#188038' }}>
      <Eye size={12} /> {count}{rel && <span className="font-normal" style={{ color: 'var(--gc-text-3)' }}>· {rel}</span>}
    </span>
  );
}

function fmtRelTime(d: Date): string {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24); if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
