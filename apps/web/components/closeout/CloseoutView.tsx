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
import { FileCheck2, Loader2, Flag, CheckCircle2, Clock, Play, Copy, ExternalLink, FileText } from 'lucide-react';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useUser } from '@clerk/nextjs';
import { railway } from '@/lib/railway';
import type { Load, CalendarEvent } from '@/lib/types';
import ManagementHeader from '@/components/nav/ManagementHeader';
import { displayBrokerName } from '@/lib/customerMatch';
import ReviewQueue from './ReviewQueue';
import { FlagModal, type FlagReason } from './FlagModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';

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
  const mergeEvents = useCalendarStore(s => s.mergeEvents);
  const { user } = useUser();

  const [tab, setTab] = useState<Tab>('pending');
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [docCounts, setDocCounts] = useState<Record<string, Record<string, number>>>({});
  const [error, setError] = useState<string | null>(null);

  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewStartIndex, setReviewStartIndex] = useState(0);
  const [flagTarget, setFlagTarget] = useState<Load | null>(null);
  const [brokerProfileId, setBrokerProfileId] = useState<string | null>(null);
  const openEditModal = useCalendarStore(s => s.openEditModal);

  const refresh = useMemo(() => async () => {
    setLoading(true);
    setError(null);
    try {
      const { loads, docCounts } = await railway.listCloseoutQueue(tab);
      setRows(loads as QueueRow[]);
      setDocCounts(docCounts ?? {});
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
    // PATCH /v1/closeout/loads/:id keys off the loads-table uuid, not
    // the event uuid. Each row in the queue is an event, so we have to
    // resolve the parent load id before sending the action.
    const targetId = load.loadId ?? load.id;
    await railway.updateLoadCloseout(targetId, { action: 'verify', actorName });
    await refresh();
  }

  function handleFlag(load: Load) {
    setFlagTarget(load);
  }

  async function confirmFlag(reason: FlagReason, note: string) {
    if (!flagTarget) return;
    const actorName = user?.fullName ?? user?.firstName ?? user?.primaryEmailAddress?.emailAddress ?? undefined;
    const targetId = flagTarget.loadId ?? flagTarget.id;
    await railway.updateLoadCloseout(targetId, { action: 'flag', flagReason: reason, flagNote: note, actorName });
    setFlagTarget(null);
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
            {(tab === 'pending' || tab === 'flagged') && dedup.length > 0 && (
              <button onClick={() => { setReviewStartIndex(0); setReviewOpen(true); }}
                className="flex items-center gap-1.5 text-[13px] font-bold px-4 py-1.5 rounded-full text-white transition-colors"
                style={{ background: '#15803d' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#166534')}
                onMouseLeave={e => (e.currentTarget.style.background = '#15803d')}>
                <Play size={13} fill="currentColor" /> Review queue ({dedup.length})
              </button>
            )}
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
                    <Th>Title</Th>
                    <Th>Customer</Th>
                    <Th>Driver(s)</Th>
                    <Th align="right">Rate</Th>
                    <Th align="right">Accessorials</Th>
                    <Th>Docs</Th>
                    <Th align="right">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {dedup.map((load, rowIdx) => {
                    const days = ageDays(load.end);
                    const ac   = ageColor(days);
                    const cust = displayBrokerName(load.broker, customers);
                    // Customer profile lookup — need the canonical id, not the raw name
                    const matchedCustomer = customers.find(c =>
                      c.name === load.broker || (c.aliases ?? []).includes(load.broker ?? ''),
                    );
                    // For relays, surface BOTH drivers
                    const relayPartner = load.relayGroupId
                      ? rows.find(r => r.id !== load.id && r.relayGroupId === load.relayGroupId)
                      : null;
                    const drivers: string[] = [];
                    if (load.driverName) drivers.push(load.driverName);
                    if (relayPartner?.driverName && relayPartner.driverName !== load.driverName) drivers.push(relayPartner.driverName);
                    const accessorialsSum = (load.accessorials ?? []).reduce((s, a) => s + (a.amount ?? 0), 0);
                    const accessorialsCount = (load.accessorials ?? []).length;
                    const targetLoadId = load.loadId ?? load.id;
                    const counts = docCounts[targetLoadId] ?? {};
                    const hasRC = !!load.rateConPdf;
                    return (
                      <tr key={load.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}
                        className="hover:bg-[var(--gc-hover)]">
                        <Td>
                          <span style={{ background: ac.bg, color: ac.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>
                            {days === 0 ? 'today' : days === 1 ? '1 day' : `${days} days`}
                          </span>
                        </Td>
                        <Td>{fmtDate(load.end)}</Td>
                        {/* Load # — copyable */}
                        <Td>
                          {load.loadNum
                            ? (
                              <button type="button"
                                onClick={e => { e.stopPropagation(); void copyToClipboard(load.loadNum!); }}
                                className="font-semibold inline-flex items-center gap-1 text-[13px] hover:underline"
                                style={{ color: 'var(--gc-text-1)' }}
                                title="Copy load #">
                                #{load.loadNum} <Copy size={11} style={{ color: 'var(--gc-text-3)' }} />
                              </button>
                            )
                            : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                        </Td>
                        {/* Title — opens event modal with full load data */}
                        <Td>
                          <button type="button"
                            onClick={e => { e.stopPropagation(); openEditModal(load.id); }}
                            className="text-left font-bold inline-flex items-center gap-1 hover:underline truncate max-w-[320px]"
                            style={{ color: 'var(--gc-blue)' }}
                            title="Open load details">
                            <span className="truncate">{load.title}</span>
                            <ExternalLink size={11} className="shrink-0" style={{ color: 'var(--gc-text-3)' }} />
                          </button>
                        </Td>
                        {/* Customer — opens broker profile */}
                        <Td>
                          {matchedCustomer ? (
                            <button type="button"
                              onClick={e => { e.stopPropagation(); setBrokerProfileId(matchedCustomer.id); }}
                              className="hover:underline"
                              style={{ color: 'var(--gc-blue)' }}
                              title="Open customer profile">
                              {cust}
                            </button>
                          ) : (
                            <span style={{ color: cust ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>{cust || '—'}</span>
                          )}
                        </Td>
                        {/* Driver(s) */}
                        <Td>
                          {drivers.length === 0
                            ? <span style={{ color: 'var(--gc-text-3)' }}>Unassigned</span>
                            : drivers.length === 1
                              ? <span>{drivers[0]}</span>
                              : (
                                <div>
                                  <div className="text-[13px]">{drivers[0]}</div>
                                  <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>+ {drivers[1]}</div>
                                </div>
                              )}
                        </Td>
                        {/* Total rate */}
                        <Td align="right" className="font-semibold tabular-nums">
                          {load.loadPrice != null ? moneyFmt.format(load.loadPrice) : '—'}
                        </Td>
                        {/* Total accessorials */}
                        <Td align="right" className="tabular-nums">
                          {accessorialsCount === 0
                            ? <span style={{ color: 'var(--gc-text-3)' }}>—</span>
                            : (
                              <div>
                                <div className="font-semibold">{moneyFmt.format(accessorialsSum)}</div>
                                <div className="text-[10px]" style={{ color: 'var(--gc-text-3)' }}>{accessorialsCount} item{accessorialsCount !== 1 ? 's' : ''}</div>
                              </div>
                            )}
                        </Td>
                        {/* Docs — chips per kind */}
                        <Td>
                          <div className="flex flex-wrap items-center gap-1">
                            <DocBadge label="RC"     present={hasRC} />
                            <DocBadge label="POD"    present={(counts.pod ?? 0)    > 0} count={counts.pod} />
                            <DocBadge label="BOL"    present={(counts.bol ?? 0)    > 0} count={counts.bol} />
                            <DocBadge label="Lumper" present={(counts.lumper ?? 0) > 0} count={counts.lumper} />
                            <DocBadge label="Scale"  present={(counts.scale ?? 0)  > 0} count={counts.scale} />
                            {(counts.other ?? 0) > 0 && <DocBadge label="Other" present count={counts.other} />}
                          </div>
                          {load.flaggedReason && (
                            <div className="mt-1">
                              <FlagChip reason={load.flaggedReason} />
                            </div>
                          )}
                        </Td>
                        {/* Actions */}
                        <Td align="right" onClick={e => e.stopPropagation()}>
                          {tab === 'pending' || tab === 'flagged' ? (
                            <div className="flex items-center justify-end gap-1.5">
                              <button onClick={() => { setReviewStartIndex(rowIdx); setReviewOpen(true); }}
                                className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                style={{ background: '#15803d', color: '#fff' }}
                                title="Open in review queue">
                                <Play size={10} fill="currentColor" style={{ display: 'inline', marginRight: 3 }} /> Review
                              </button>
                              <button onClick={() => void handleVerify(load)}
                                className="text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors"
                                style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }}
                                title="Release without opening review queue">
                                <CheckCircle2 size={11} style={{ display: 'inline', marginRight: 3 }} /> Release
                              </button>
                              {tab === 'pending' && (
                                <button onClick={() => handleFlag(load)}
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

      {/* Customer profile modal */}
      {brokerProfileId && (
        <BrokerProfileModal initialBrokerId={brokerProfileId} onClose={() => setBrokerProfileId(null)} />
      )}

      {/* Focused review queue overlay */}
      {reviewOpen && (
        <ReviewQueue
          loads={dedup}
          startIndex={reviewStartIndex}
          onClose={() => { setReviewOpen(false); void refresh(); }}
          onLoadResolved={() => { /* refresh happens on close */ }}
        />
      )}

      {/* Inline flag modal (used from row buttons; review queue has its own) */}
      {flagTarget && (
        <FlagModal
          loadLabel={`${flagTarget.title}${flagTarget.loadNum ? ` · #${flagTarget.loadNum}` : ''}`}
          onCancel={() => setFlagTarget(null)}
          onConfirm={confirmFlag}
        />
      )}
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

function DocBadge({ label, present, count }: { label: string; present: boolean; count?: number }) {
  return (
    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold tabular-nums"
      title={present ? `${count ?? ''} ${label} uploaded`.trim() : `${label} missing`}
      style={{
        background: present ? '#dcfce7' : '#f1f3f4',
        color:      present ? '#15803d' : 'var(--gc-text-3)',
        border:     `1px solid ${present ? '#86efac' : 'var(--gc-border-light)'}`,
        opacity:    present ? 1 : 0.7,
      }}>
      {label}{count && count > 1 ? ` ×${count}` : ''}
    </span>
  );
}

async function copyToClipboard(text: string) {
  try { await navigator.clipboard.writeText(text); }
  catch { /* clipboard API blocked — silent */ }
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
