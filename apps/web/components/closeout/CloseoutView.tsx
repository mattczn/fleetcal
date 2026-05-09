'use client';

/**
 * /closeout — POD verification + release queue.
 *
 * Tabs:
 *  Pending     — loads delivered/due that haven't been verified yet
 *  Flagged     — held back pending follow-up (missing POD, rate dispute, …)
 *  Verified    — released for invoicing, awaiting accounting batch
 *  Invoiced    — sent to broker, awaiting payment
 *  Paid        — closed out
 *
 * Default is Pending, sorted oldest delivery first. Click a row → opens
 * the existing event modal (the focused review-queue mode is the next
 * iteration). Fetched events are merged into the calendar store so the
 * modal can find them even when they're outside the calendar's loaded
 * window.
 */

import { useEffect, useMemo, useState } from 'react';
import { FileCheck2, Loader2, Flag, AlertCircle, CheckCircle2, FileText, Clock } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import type { Load, CalendarEvent } from '@/lib/types';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { displayBrokerName } from '@/lib/customerMatch';

type Tab = 'pending' | 'flagged' | 'verified' | 'invoiced' | 'paid';

const TABS: { value: Tab; label: string }[] = [
  { value: 'pending',  label: 'Pending'   },
  { value: 'flagged',  label: 'Flagged'   },
  { value: 'verified', label: 'Verified'  },
  { value: 'invoiced', label: 'Invoiced'  },
  { value: 'paid',     label: 'Paid'      },
];

function ageDays(deliveredEnd: string): number {
  const t = new Date(deliveredEnd).getTime();
  if (isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function ageColor(days: number): { bg: string; fg: string } {
  if (days <= 1) return { bg: '#dcfce7', fg: '#15803d' };
  if (days <= 3) return { bg: '#fef3c7', fg: '#92400e' };
  if (days <= 7) return { bg: '#fed7aa', fg: '#9a3412' };
  return { bg: '#fee2e2', fg: '#991b1b' };
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 });

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface QueueRow extends CalendarEvent { /* alias for clarity */ }

export default function CloseoutView() {
  const customers = useCalendarStore(s => s.customers);
  const openEditModal = useCalendarStore(s => s.openEditModal);
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const { user } = useUser();

  const [tab, setTab] = useState<Tab>('pending');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const { loads } = await railway.listCloseoutQueue(tab);
      setRows(loads as QueueRow[]);
      // Push into the calendar store so EventModal can resolve them by
      // id (closeout queue often pulls loads outside the calendar's
      // loaded date window).
      mergeEvents(loads as QueueRow[]);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load queue');
    } finally {
      setLoading(false);
    }
  }, [tab, mergeEvents]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Dedup relays — one row per load (the pickup leg wins).
  const dedup = useMemo(() => {
    const pickupGroups = new Set(
      rows.filter(r => r.relayGroupId && r.relayRole === 'pickup').map(r => r.relayGroupId!),
    );
    return rows.filter(r => {
      if (!r.relayGroupId) return true;
      if (r.relayRole === 'pickup') return true;
      if (r.relayRole === 'delivery') return !pickupGroups.has(r.relayGroupId);
      return true;
    });
  }, [rows]);

  const tabCount = (t: Tab) => t === tab ? dedup.length : null;

  async function handleVerify(load: Load) {
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    await railway.updateLoadCloseout(load.id, { action: 'verify', actorName });
    await refresh();
  }

  async function handleFlag(load: Load) {
    const reason = window.prompt(
      'Flag reason (missing_pod | awaiting_rate_con | detention_pending | lumper_pending | rate_mismatch | other):',
      'missing_pod',
    );
    if (!reason) return;
    const note = window.prompt('Follow-up note (what we\'re waiting on):') ?? '';
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    await railway.updateLoadCloseout(load.id, { action: 'flag', flagReason: reason as 'missing_pod', flagNote: note, actorName });
    await refresh();
  }

  return (
    <div className="flex-1 flex flex-col h-full" style={{ background: 'var(--gc-bg)' }}>
      <ManagementHeader title="Closeout" icon={FileCheck2} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-[1600px] mx-auto space-y-4">

          {/* Tab pills */}
          <div className="flex items-center gap-1.5">
            {TABS.map(({ value, label }) => {
              const active = tab === value;
              const count = tabCount(value);
              return (
                <button key={value} onClick={() => setTab(value)}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-semibold transition-colors"
                  style={{
                    border: `1px solid ${active ? '#1a73e8' : 'var(--gc-border)'}`,
                    background: active ? '#1a73e8' : 'var(--gc-surface)',
                    color: active ? '#fff' : 'var(--gc-text-2)',
                  }}>
                  {label}
                  {count != null && (
                    <span style={{
                      background: active ? 'rgba(255,255,255,0.22)' : 'var(--gc-border-light)',
                      color: active ? '#fff' : 'var(--gc-text-3)',
                      padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700,
                    }}>{count}</span>
                  )}
                </button>
              );
            })}
            <div className="flex-1" />
            <button onClick={() => void refresh()}
              className="text-xs font-medium px-3 py-1.5 rounded-full transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}>
              Refresh
            </button>
          </div>

          {/* Body */}
          {loading ? (
            <div className="flex items-center justify-center py-24" style={{ color: 'var(--gc-text-3)' }}>
              <Loader2 size={20} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
              {error}
            </div>
          ) : dedup.length === 0 ? (
            <EmptyState tab={tab} />
          ) : (
            <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
              <table className="w-full text-sm" style={{ borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--gc-bg)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <Th>Age</Th>
                    <Th>Delivered</Th>
                    <Th>Load #</Th>
                    <Th>Customer</Th>
                    <Th>Route</Th>
                    <Th>Driver / Asset</Th>
                    <Th align="right">Rate</Th>
                    <Th>Docs</Th>
                    <Th>Flag</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {dedup.map(load => {
                    const days = ageDays(load.end);
                    const ac   = ageColor(days);
                    const cust = displayBrokerName(load.broker, customers);
                    const stops = load.stops ?? [];
                    const origin = stops[0]?.city ?? stops[0]?.facilityName ?? '—';
                    const dest = stops[stops.length - 1]?.city ?? stops[stops.length - 1]?.facilityName ?? '—';
                    return (
                      <tr key={load.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                        className="hover:bg-[var(--gc-hover)] cursor-pointer"
                        onClick={() => openEditModal(load.id)}>
                        <Td>
                          <span style={{ background: ac.bg, color: ac.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                            {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
                          </span>
                        </Td>
                        <Td>{fmtDate(load.end)}</Td>
                        <Td className="font-semibold">{load.loadNum ? `#${load.loadNum}` : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}</Td>
                        <Td>{cust || <span style={{ color: 'var(--gc-text-3)' }}>—</span>}</Td>
                        <Td>
                          <span style={{ color: 'var(--gc-text-2)' }}>
                            {origin} → {dest}
                          </span>
                        </Td>
                        <Td>
                          <div className="text-[13px]">{load.driverName ?? <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>}</div>
                          <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{load.assetName ?? ''}</div>
                        </Td>
                        <Td align="right" className="font-semibold">
                          {load.loadPrice != null ? moneyFmt.format(load.loadPrice) : '—'}
                        </Td>
                        <Td><DocChip load={load} /></Td>
                        <Td>{load.flaggedReason ? <FlagChip reason={load.flaggedReason} /> : null}</Td>
                        <Td align="right" onClick={e => e.stopPropagation()}>
                          {tab === 'pending' || tab === 'flagged' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button onClick={() => void handleVerify(load)}
                                className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}>
                                <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 3 }} /> Release
                              </button>
                              {tab === 'pending' && (
                                <button onClick={() => void handleFlag(load)}
                                  className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                  style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                                  <Flag size={11} style={{ display: 'inline', marginRight: 3 }} /> Flag
                                </button>
                              )}
                            </div>
                          ) : null}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th className="px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wider"
      style={{ color: 'var(--gc-text-3)', textAlign: align }}>
      {children}
    </th>
  );
}

function Td({ children, align = 'left', className, onClick }: { children: React.ReactNode; align?: 'left' | 'right'; className?: string; onClick?: (e: React.MouseEvent) => void }) {
  return (
    <td className={`px-3 py-2.5 ${className ?? ''}`} style={{ textAlign: align, color: 'var(--gc-text-1)' }} onClick={onClick}>
      {children}
    </td>
  );
}

function DocChip({ load }: { load: Load }) {
  // Best-effort: count uploads of each kind without fetching documents.
  // For now, fall back to a generic "View" hint — the modal shows the full list.
  const hasRateCon = !!load.rateConPdf;
  return (
    <div className="flex items-center gap-1">
      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
        style={{ background: hasRateCon ? '#dcfce7' : '#f1f3f4', color: hasRateCon ? '#15803d' : 'var(--gc-text-3)' }}>
        <FileText size={9} /> {hasRateCon ? 'RC' : 'No RC'}
      </span>
    </div>
  );
}

function FlagChip({ reason }: { reason: string }) {
  const label = ({
    missing_pod:        'Missing POD',
    awaiting_rate_con:  'Rate-con pending',
    detention_pending:  'Detention pending',
    lumper_pending:     'Lumper pending',
    rate_mismatch:      'Rate mismatch',
    other:              'Other',
  } as Record<string, string>)[reason] ?? reason;
  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold"
      style={{ background: '#fef3c7', color: '#92400e' }}>
      <Flag size={9} /> {label}
    </span>
  );
}

function EmptyState({ tab }: { tab: Tab }) {
  const messages: Record<Tab, { icon: React.ReactNode; title: string; sub: string }> = {
    pending:  { icon: <CheckCircle2 size={28} style={{ color: '#15803d' }} />, title: 'All caught up', sub: 'Every overdue load has been verified or flagged.' },
    flagged:  { icon: <Flag         size={28} style={{ color: '#92400e' }} />, title: 'No flagged loads', sub: 'Anything that needs follow-up will show here.' },
    verified: { icon: <Clock        size={28} style={{ color: '#1a73e8' }} />, title: 'Nothing waiting on accounting', sub: 'Verified loads ready to invoice will land here.' },
    invoiced: { icon: <FileText     size={28} style={{ color: 'var(--gc-text-3)' }} />, title: 'No invoiced loads', sub: 'Loads sent to brokers but unpaid will show here.' },
    paid:     { icon: <CheckCircle2 size={28} style={{ color: '#15803d' }} />, title: 'No paid loads in view', sub: 'Closed-out loads will show here.' },
  };
  const m = messages[tab];
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center" style={{ color: 'var(--gc-text-3)' }}>
      <div className="mb-3">{m.icon}</div>
      <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>{m.title}</div>
      <div className="text-sm">{m.sub}</div>
    </div>
  );
}
