'use client';

/**
 * /receivables/[customerId] — one broker's whole picture.
 *
 * Answers two questions the ledger row can only hint at: is this a slow
 * payer or a problem, and which specific invoices are at risk.
 *
 * Four blocks — identity, three visual cards, then every open invoice
 * grouped oldest-bucket-first so at-risk money sits at the top instead
 * of being buried in date order. The invoice list does NOT paginate;
 * one broker's book is small enough to read whole, and paging it would
 * hide exactly the tail you opened the page for.
 *
 * All aging and behaviour math arrives from
 * /v1/payments/receivables/:customerId already computed. The page does
 * no bucketing of its own — the figure someone chases a broker over
 * shouldn't depend on which screen they read it from.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  HandCoins, Mail, Phone, Truck, ArrowRightLeft, Download, ChevronLeft,
  ExternalLink, MapPin, StickyNote, UserRound, Check,
} from 'lucide-react';
import RequireCap from '@/components/auth/RequireCap';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import EventModal from '@/components/calendar/EventModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import BulkPaymentPanel from '../BulkPaymentPanel';
import Breadcrumbs from '@/app/admin/Breadcrumbs';
import Tooltip from '@/components/ui/Tooltip';
import { CopyableCell, CopyableLoadNum, StatusPill } from '@/components/queue/QueueTablePrimitives';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import { useCalendarStore } from '@/store/useCalendarStore';
import { railway } from '@/lib/railway';
import type { CustomerReceivables, ReceivableInvoice, AgingBucket } from '@fleetcal/types';
import { AGING_BUCKETS, AGING_BUCKET_LABEL, agingBucketFor } from '@fleetcal/types';

const money0 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
const money2 = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString([], { month: 'short', day: '2-digit', year: '2-digit' });

const ageColor = (d: number | null) =>
  d === null || d <= 0 ? 'var(--gc-text-3)' : d <= 30 ? '#b06000' : '#c5221f';
const ageLabel = (d: number | null) =>
  d === null ? '—' : d <= 0 ? `${Math.abs(d)}d left` : `${d}d over`;

/** Three buckets, matching the ledger. The handoff drew four — 61+ and
 *  31–60 as separate groups — but those were merged into one 31+ bucket
 *  since; the decision is the same either side of 60 days. */
const GROUP_STYLE: Record<AgingBucket, {
  heading: string; bg: string; border: string; fg: string; dot: string;
}> = {
  d31_plus: { heading: '31+ days · at risk',    bg: '#fce8e6',       border: '1px solid #f6aea9', fg: '#c5221f',          dot: '#c5221f' },
  d1_30:    { heading: '1–30 days',             bg: '#fffbeb',       border: '1px solid #f1f3f4', fg: '#b06000',          dot: '#fddc9a' },
  current:  { heading: 'Current · not due yet', bg: 'var(--gc-bg)',  border: '1px solid #f1f3f4', fg: 'var(--gc-text-2)', dot: '#c6dafc' },
};
/** Worst first — the point of grouping. */
const GROUP_ORDER: AgingBucket[] = ['d31_plus', 'd1_30', 'current'];

/** Bar ramp for the aging breakdown card. */
const SEG_COLOR: Record<AgingBucket, string> = {
  current: '#c6dafc', d1_30: '#fddc9a', d31_plus: '#c5221f',
};
const BUCKET_FG: Record<AgingBucket, string> = {
  current: '#3c4043', d1_30: '#b06000', d31_plus: '#c5221f',
};

const GRID = '34px 78px 100px 104px 1fr 92px 92px 92px 100px 100px 100px 96px';

type Scope = 'open' | 'paid' | 'all';

function CustomerViewInner() {
  const params     = useParams<{ customerId: string }>();
  const router     = useRouter();
  const customerId = params?.customerId ?? '';

  const [data,    setData]    = useState<CustomerReceivables | null>(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState<string | null>(null);
  const [scope,   setScope]   = useState<Scope>('open');
  const [search,  setSearch]  = useState('');
  const [term,    setTerm]    = useState('');
  const [openInvoiceId, setOpenInvoiceId] = useState<string | null>(null);
  const [profileOpen,   setProfileOpen]   = useState(false);
  const [selected,      setSelected]      = useState<Set<string>>(new Set());
  const [bulkOpen,      setBulkOpen]      = useState(false);
  // Scrolling the invoice list collapses the blocks above it. Hysteresis
  // (40 down / 8 up) rather than a single threshold, so a row sitting
  // near the boundary doesn't flicker the whole header on every wheel
  // tick. Same treatment as the ledger's bucket tiles.
  const [compact,       setCompact]       = useState(false);

  const load = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const res = await railway.getCustomerReceivables(customerId, { scope });
      setData(res.customer);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load customer');
    } finally {
      setLoading(false);
    }
  }, [customerId, scope]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim().toLowerCase()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const invoices = useMemo(() => {
    const all = data?.invoices ?? [];
    if (!term) return all;
    return all.filter(i =>
      i.invoiceNumber.toLowerCase().includes(term) ||
      (i.loadNum ?? '').toLowerCase().includes(term) ||
      (i.title ?? '').toLowerCase().includes(term));
  }, [data, term]);

  /** Grouping only applies to Open — Paid and All are read
   *  chronologically, where an aging bucket means nothing. */
  const groups = useMemo(() => {
    if (scope !== 'open') return null;
    const m = new Map<AgingBucket, ReceivableInvoice[]>();
    for (const inv of invoices) {
      const b = agingBucketFor(inv.agingDays);
      const list = m.get(b) ?? [];
      list.push(inv);
      m.set(b, list);
    }
    return GROUP_ORDER
      .map(b => ({ bucket: b, rows: m.get(b) ?? [] }))
      .filter(g => g.rows.length > 0);
  }, [invoices, scope]);

  const payable = useMemo(() => invoices.filter(i => i.balance > 0.005), [invoices]);
  const allSelected = payable.length > 0 && payable.every(i => selected.has(i.id));

  const toggleOne = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const toggleAll = useCallback(() => {
    setSelected(prev => (prev.size >= payable.length ? new Set() : new Set(payable.map(i => i.id))));
  }, [payable]);

  const selectedInvoices = useMemo(
    () => payable.filter(i => selected.has(i.id)),
    [payable, selected],
  );

  // EventModal keys on calendar events, so make sure the load's legs are
  // in the store before opening. Same fallback Billing uses.
  const mergeEvents   = useCalendarStore(st => st.mergeEvents);
  const openEditModal = useCalendarStore(st => st.openEditModal);
  const openLoadInModal = useCallback(async (inv: ReceivableInvoice) => {
    if (!inv.pickupEventId) return;
    const inStore = useCalendarStore.getState().events.some(e => e.id === inv.pickupEventId);
    if (!inStore) {
      try {
        const { loads: legs } = await railway.getLoad(inv.loadId);
        mergeEvents(legs);
      } catch (e) {
        console.error('[receivables] failed to load legs for modal:', e);
        return;
      }
    }
    openEditModal(inv.pickupEventId);
  }, [mergeEvents, openEditModal]);

  const summary   = data?.summary;
  const balance   = summary?.openBalance ?? 0;
  const pastDue   = summary?.overdueBalance ?? 0;
  const pastDuePct = balance > 0 ? Math.round((pastDue / balance) * 100) : 0;
  const collected = invoices.reduce((s, i) => s + i.paidAmount, 0);

  const initials = (data?.customerName ?? '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');

  const rightSlot = (
    <div className="flex items-center gap-2">
      <Tooltip content="Statements aren't wired up yet." placement="bottom">
        <span className="inline-flex items-center gap-1.5" style={{
          height: 32, padding: '0 12px', border: '1px solid var(--gc-border)', borderRadius: 8,
          background: 'var(--gc-surface)', fontSize: 12, fontWeight: 700,
          color: 'var(--gc-text-2)', opacity: 0.55, cursor: 'default',
        }}>
          <Mail size={13} /> Send statement
        </span>
      </Tooltip>
      <Tooltip content="Remittance matching isn't wired up yet — record payments from the Receivables ledger." placement="bottom">
        <span className="inline-flex items-center gap-1.5" style={{
          height: 32, padding: '0 12px', borderRadius: 8, background: '#1a73e8',
          color: '#fff', fontSize: 12, fontWeight: 700, opacity: 0.55, cursor: 'default',
        }}>
          <ArrowRightLeft size={13} /> Apply a payment
        </span>
      </Tooltip>
    </div>
  );

  const peak = Math.max(1, ...(data?.weekly ?? []).map(w => w.amount));

  return (
    <AppShell title="Receivables" icon={HandCoins} rightSlot={rightSlot} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0" style={{ padding: '18px 24px', gap: 14 }}>

        <div style={{ flex: 'none' }} className="flex items-center gap-3">
          <button onClick={() => router.push('/receivables')}
            className="grid place-items-center"
            style={{
              width: 26, height: 26, border: '1px solid var(--gc-border)', borderRadius: 7,
              background: 'var(--gc-surface)', color: 'var(--gc-text-2)', flex: 'none',
            }}
            title="Back to Receivables">
            <ChevronLeft size={14} />
          </button>
          <Breadcrumbs trail={[
            { label: 'Receivables', href: '/receivables' },
            { label: data?.customerName ?? '…' },
          ]} />
        </div>

        {err && (
          <div style={{
            flex: 'none', borderRadius: 12, background: '#fee2e2',
            border: '1px solid #fecaca', color: '#991b1b', fontSize: 14, padding: 14,
          }}>{err}</div>
        )}

        {/* ── Identity ─────────────────────────────────────────────── */}
        <div style={{ flex: 'none', ...CARD, padding: compact ? '9px 16px' : '14px 16px', transition: 'padding 140ms ease' }}
             className="flex items-center gap-3.5">
          <span style={{
            width: compact ? 30 : 44, height: compact ? 30 : 44, borderRadius: 11, flex: 'none',
            transition: 'width 140ms ease, height 140ms ease',
            background: 'var(--gc-blue-light, #e8f0fe)', display: 'grid', placeItems: 'center',
            fontSize: compact ? 12 : 15, fontWeight: 800, color: 'var(--gc-blue-text)',
          }}>{initials || '—'}</span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="truncate" style={{ fontSize: compact ? 15 : 20, fontWeight: 800, letterSpacing: '-0.3px' }}>
                {data?.customerName ?? (loading ? 'Loading…' : 'Customer')}
              </span>
              {(summary?.overdueCount ?? 0) > 0 && (
                <Badge bg="#fce8e6" fg="#c5221f">{summary?.overdueCount} past due</Badge>
              )}
              {data?.mcNum && <Badge bg="#f1f3f4" fg="#5f6368">MC {data.mcNum}</Badge>}
            </div>
            <div className="flex items-center flex-wrap" style={{
              gap: 14, marginTop: 4, fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)',
              display: compact ? 'none' : undefined,
            }}>
              {data?.invoiceEmail && <Meta icon={<Mail size={12} />}>{data.invoiceEmail}</Meta>}
              {data?.contactPhone && <Meta icon={<Phone size={12} />}>{data.contactPhone}</Meta>}
              {data?.lifetimeLoads != null && (
                <Meta icon={<Truck size={12} />}>{data.lifetimeLoads.toLocaleString()} loads</Meta>
              )}
            </div>
          </div>

          {data?.customerId && (
            <button onClick={() => setProfileOpen(true)}
              className="inline-flex items-center gap-1.5" style={{
                height: 32, padding: '0 12px', border: '1px solid var(--gc-border)',
                borderRadius: 8, background: 'var(--gc-surface)',
                fontSize: 12, fontWeight: 700, color: 'var(--gc-text-2)', flex: 'none',
              }}
              title="Open the full customer record">
              <UserRound size={13} /> View customer
            </button>
          )}

          <div style={{ textAlign: 'right', flex: 'none' }}>
            <div style={{
              fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '.08em', color: 'var(--gc-text-3)',
            }}>Open balance</div>
            <div className="tabular-nums" style={{
              fontSize: compact ? 18 : 26, fontWeight: 800, letterSpacing: '-0.6px',
              transition: 'font-size 140ms ease',
            }}>
              {money0(balance)}
            </div>
          </div>
        </div>

        {/* ── Visuals ──────────────────────────────────────────────── */}
        {!compact && (
        <div className="flex" style={{ flex: 'none', gap: 12 }}>

          {/* A — aging breakdown */}
          <div style={{ ...CARD, padding: '14px 16px', flex: 1.15, minWidth: 0 }}>
            <CardTitle
              title="Aging breakdown"
              caption={balance > 0
                ? `${pastDuePct}% of this balance is past terms`
                : 'Nothing outstanding'} />
            <div className="flex flex-col" style={{ gap: 8, marginTop: 10 }}>
              {AGING_BUCKETS.map(b => {
                const amt   = summary?.byBucket?.[b] ?? 0;
                const count = invoices.filter(i => i.balance > 0.005 && agingBucketFor(i.agingDays) === b).length;
                const w     = balance > 0 ? `${(amt / balance * 100).toFixed(1)}%` : '0%';
                return (
                  <div key={b} style={{
                    display: 'grid', gridTemplateColumns: '74px 1fr 86px 66px',
                    gap: 10, alignItems: 'center',
                  }}>
                    <span style={{ fontSize: 11.5, fontWeight: 700, color: BUCKET_FG[b] }}>
                      {AGING_BUCKET_LABEL[b]}
                    </span>
                    <span style={{ height: 10, borderRadius: 999, background: '#f1f3f4', overflow: 'hidden' }}>
                      <span style={{ display: 'block', height: '100%', width: w, background: SEG_COLOR[b], borderRadius: 999 }} />
                    </span>
                    <span className="tabular-nums" style={{ textAlign: 'right', fontSize: 12.5, fontWeight: 800 }}>
                      {money0(amt)}
                    </span>
                    <span style={{ textAlign: 'right', fontSize: 11, fontWeight: 600, color: 'var(--gc-text-3)' }}>
                      {count} invoice{count === 1 ? '' : 's'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* B — KPIs */}
          <div style={{ ...CARD, padding: '14px 16px', width: 296, flex: 'none' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 14px' }}>
              <Kpi label="Past due" value={money0(pastDue)} valueColor={pastDue > 0 ? '#c5221f' : 'var(--gc-text-1)'} />
              <Kpi label="Oldest"
                   value={summary?.oldestAgingDays == null ? '—' : `${Math.max(summary.oldestAgingDays, 0)}d`}
                   valueColor={ageColor(summary?.oldestAgingDays ?? null)} />
              <Kpi label="Avg days to pay"
                   value={summary?.avgDaysToPay != null ? `${summary.avgDaysToPay}d` : '—'}
                   valueColor={
                     summary?.avgDaysToPay != null && summary.termsDays != null
                       ? (summary.avgDaysToPay > summary.termsDays ? '#b06000' : '#137333')
                       : 'var(--gc-text-1)'
                   }
                   sub={
                     summary?.avgDaysToPay != null && summary.termsDays != null
                       ? (summary.avgDaysToPay > summary.termsDays
                           ? `${summary.avgDaysToPay - summary.termsDays}d past terms`
                           : 'within terms')
                       : undefined
                   } />
              <Kpi label="Paid 90d" value={money0(data?.paid90d ?? 0)} valueColor="#137333"
                   sub={`${data?.paid90dCount ?? 0} payment${(data?.paid90dCount ?? 0) === 1 ? '' : 's'}`} />
            </div>
          </div>

          {/* C — collections, 12 weeks. Plain divs, no chart library. */}
          <div style={{ ...CARD, padding: '14px 16px', flex: 1, minWidth: 0 }} className="flex flex-col">
            <CardTitle title="Payments received" caption="Last 12 weeks" />
            <div className="flex items-end" style={{ gap: 6, height: 74, marginTop: 10 }}>
              {(data?.weekly ?? []).map((w, i) => {
                const isThisWeek = i === (data?.weekly.length ?? 1) - 1;
                const h = w.amount > 0 ? Math.max(8, Math.round(w.amount / peak * 74)) : 2;
                return (
                  <span key={w.weekStart} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}
                    title={w.amount > 0 ? `${money0(w.amount)} · week of ${w.weekStart}` : `no payment · week of ${w.weekStart}`}>
                    <span style={{
                      display: 'block', width: '100%', height: h,
                      borderRadius: '4px 4px 2px 2px',
                      background: w.amount === 0 ? '#e8eaed' : isThisWeek ? '#1a73e8' : '#c6dafc',
                    }} />
                  </span>
                );
              })}
            </div>
            <div className="flex items-center justify-between" style={{
              marginTop: 8, fontSize: 10.5, fontWeight: 600, color: 'var(--gc-text-3)',
            }}>
              <span>{data?.weekly?.[0]?.weekStart ?? ''}</span>
              <span>
                this week · {money0(data?.weekly?.[data.weekly.length - 1]?.amount ?? 0)}
              </span>
            </div>
          </div>
        </div>
        )}

        {/* ── How to bill them ─────────────────────────────────────── */}
        {/* Read-only mirror of the Customer record — BrokerProfileModal
            is the edit surface, reachable from View customer above, so
            this doesn't duplicate a form. */}
        {!compact && (
        <div style={{ flex: 'none', ...CARD, padding: '12px 16px' }}>
          <div className="flex items-start flex-wrap" style={{ gap: 24 }}>
            <BillingField
              icon={data?.invoiceMethod === 'portal' ? <ExternalLink size={12} /> : <Mail size={12} />}
              label="Invoice routing">
              {data?.invoiceMethod === 'portal' ? 'Online portal'
                : data?.invoiceMethod === 'email' ? 'Email'
                : <Muted>not set</Muted>}
            </BillingField>

            {/* Only the destination that matches the routing is shown —
                a stale email under a portal broker is a trap. */}
            <BillingField icon={<Mail size={12} />}
              label={data?.invoiceMethod === 'portal' ? 'Portal' : 'Billing email'}>
              {data?.invoiceMethod === 'portal'
                ? (data?.invoicePortal
                    ? <a href={/^https?:\/\//.test(data.invoicePortal) ? data.invoicePortal : `https://${data.invoicePortal}`}
                         target="_blank" rel="noopener noreferrer"
                         className="hover:underline inline-flex items-center gap-1"
                         style={{ color: 'var(--gc-blue-text)' }}>
                        {data.invoicePortal} <ExternalLink size={11} />
                      </a>
                    : <Muted>no portal on file</Muted>)
                : (data?.invoiceEmail
                    ? <a href={`mailto:${data.invoiceEmail}`} className="hover:underline"
                         style={{ color: 'var(--gc-blue-text)' }}>{data.invoiceEmail}</a>
                    : <Muted>no billing email on file</Muted>)}
            </BillingField>

            <BillingField icon={<MapPin size={12} />} label="Billing address">
              {data?.billingAddress
                ? <span style={{ whiteSpace: 'pre-line' }}>{data.billingAddress}</span>
                : <Muted>not set</Muted>}
            </BillingField>

            <BillingField icon={<StickyNote size={12} />} label="Billing notes" grow>
              {data?.billingNotes
                ? <span style={{ whiteSpace: 'pre-line' }}>{data.billingNotes}</span>
                : <Muted>none</Muted>}
            </BillingField>
          </div>
        </div>
        )}

        {/* ── Invoices ─────────────────────────────────────────────── */}
        <div className="flex flex-col" style={{ ...CARD, flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div className="flex items-center" style={{
            height: 50, flex: 'none', padding: '0 14px', gap: 10,
            borderBottom: '1px solid var(--gc-border-light)',
          }}>
            <span style={{ fontSize: 13.5, fontWeight: 800, color: 'var(--gc-text-1)' }}>
              {scope === 'open' ? 'Open invoices' : scope === 'paid' ? 'Paid invoices' : 'All invoices'}
            </span>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
              {invoices.length} · {money0(invoices.reduce((s, i) => s + i.balance, 0))}
              {scope === 'open' ? ' · grouped by age' : ''}
            </span>
            <div style={{ flex: 1 }} />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Invoice or load #"
              style={{
                height: 30, padding: '0 10px', width: 190, border: '1px solid var(--gc-border)',
                borderRadius: 8, fontSize: 12, color: 'var(--gc-text-1)', outline: 'none',
                background: 'var(--gc-surface)',
              }} />
            <div className="flex" style={{ height: 30, border: '1px solid var(--gc-border)', borderRadius: 8, overflow: 'hidden' }}>
              {(['open', 'paid', 'all'] as Scope[]).map(s => (
                <button key={s}
                  // Clear on scope change in the handler rather than an
                  // effect: a selection made under Open must not carry
                  // into Paid, where Mark Paid means nothing.
                  onClick={() => { setScope(s); setSelected(new Set()); }}
                  style={{
                    padding: '0 11px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize',
                    background: scope === s ? '#1a73e8' : 'transparent',
                    color:      scope === s ? '#fff' : 'var(--gc-text-3)',
                  }}>{s}</button>
              ))}
            </div>
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '0 14px',
            height: 36, flex: 'none', alignItems: 'center',
            borderBottom: '1px solid var(--gc-border-light)',
            fontSize: 11, fontWeight: 700, letterSpacing: '.05em',
            textTransform: 'uppercase', color: 'var(--gc-text-3)',
          }}>
            <span>
              <input type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                style={{ width: 15, height: 15, cursor: 'pointer' }}
                title={allSelected ? 'Clear selection' : 'Select all payable'} />
            </span>
            <span style={{ textAlign: 'right' }}>Age</span>
            <span>Invoice</span>
            <span>Load</span>
            <span>Title</span>
            <span>Pickup</span>
            <span>Issued</span>
            <span>Due</span>
            <span style={{ textAlign: 'right' }}>Total</span>
            <span style={{ textAlign: 'right' }}>Paid</span>
            <span style={{ textAlign: 'right' }}>Balance</span>
            <span style={{ textAlign: 'center' }}>Status</span>
          </div>

          {/* Every row renders — no pagination on one broker's book. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
               onScroll={e => {
                 const y = e.currentTarget.scrollTop;
                 if (y > 40 && !compact) setCompact(true);
                 else if (y < 8 && compact) setCompact(false);
               }}>
            {loading ? (
              <div style={{ padding: 24, fontSize: 12.5, color: 'var(--gc-text-3)' }}>Loading…</div>
            ) : invoices.length === 0 ? (
              <div style={{ padding: 24, fontSize: 13, color: 'var(--gc-text-3)' }}>
                Nothing outstanding for this customer.
              </div>
            ) : groups ? (
              groups.map(g => (
                <div key={g.bucket}>
                  <div className="flex items-center" style={{
                    height: 32, gap: 9, padding: '0 14px',
                    position: 'sticky', top: 0, zIndex: 1,
                    background: GROUP_STYLE[g.bucket].bg,
                    borderBottom: GROUP_STYLE[g.bucket].border,
                  }}>
                    <span style={{ width: 9, height: 9, borderRadius: 999, background: GROUP_STYLE[g.bucket].dot, flex: 'none' }} />
                    <span style={{ fontSize: 11.5, fontWeight: 800, color: GROUP_STYLE[g.bucket].fg }}>
                      {GROUP_STYLE[g.bucket].heading}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--gc-text-3)' }}>
                      {g.rows.length}
                    </span>
                    <div style={{ flex: 1 }} />
                    <span className="tabular-nums" style={{ fontSize: 12, fontWeight: 800, color: GROUP_STYLE[g.bucket].fg }}>
                      {money0(g.rows.reduce((s, i) => s + i.balance, 0))}
                    </span>
                  </div>
                  {g.rows.map(inv => (
                    <InvoiceRow key={inv.id} inv={inv} onOpen={setOpenInvoiceId}
                      onOpenLoad={openLoadInModal}
                      selected={selected.has(inv.id)} onToggle={toggleOne} />
                  ))}
                </div>
              ))
            ) : (
              invoices.map(inv => (
                <InvoiceRow key={inv.id} inv={inv} onOpen={setOpenInvoiceId}
                  onOpenLoad={openLoadInModal}
                  selected={selected.has(inv.id)} onToggle={toggleOne} />
              ))
            )}
          </div>

          <div className="flex items-center" style={{
            height: 42, flex: 'none', padding: '0 14px', background: 'var(--gc-bg)',
            borderTop: '1px solid var(--gc-border-light)',
          }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>
              {invoices.length} {scope} invoice{invoices.length === 1 ? '' : 's'} ·{' '}
              {money0(invoices.reduce((s, i) => s + i.balance, 0))} outstanding
              {collected > 0 ? ` · ${money0(collected)} collected against them so far` : ''}
            </span>
            {selected.size > 0 && (
              <button onClick={() => setBulkOpen(true)}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors inline-flex items-center gap-1.5"
                style={{ background: '#dcfce7', color: '#15803d', border: '1px solid #86efac', marginLeft: 14 }}>
                <Check size={12} />
                Mark {selected.size} paid
              </button>
            )}
            <div style={{ flex: 1 }} />
            {/* Statement generation isn't built — rendered so the
                affordance is where the design puts it. */}
            <Tooltip content="Statement PDFs aren't wired up yet." placement="top">
              <span className="inline-flex items-center gap-1.5" style={{
                fontSize: 11.5, fontWeight: 700, color: '#1967d2', opacity: 0.55, cursor: 'default',
              }}>
                <Download size={12} /> Download statement PDF
              </span>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* DataLoader hydrates the calendar store; EventModal renders an
          opened load. Both must be mounted here — openEditModal only
          sets store state. */}
      <DataLoader />
      <EventModal />
      {openInvoiceId && (
        <InvoiceDetailModal invoiceId={openInvoiceId} onClose={() => setOpenInvoiceId(null)} />
      )}
      {bulkOpen && selectedInvoices.length > 0 && (
        <BulkPaymentPanel
          invoices={selectedInvoices}
          customerId={data?.customerId ?? undefined}
          customerName={data?.customerName ?? 'Customer'}
          onSaved={() => { setSelected(new Set()); void load(); }}
          onClose={() => setBulkOpen(false)}
        />
      )}
      {profileOpen && data?.customerId && (
        <BrokerProfileModal initialBrokerId={data.customerId}
          onClose={() => { setProfileOpen(false); void load(); }} />
      )}
    </AppShell>
  );
}

// ── bits ──────────────────────────────────────────────────────────────

const CARD: React.CSSProperties = {
  background: 'var(--gc-surface)',
  border: '1px solid var(--gc-border-light)',
  borderRadius: 14,
  boxShadow: '0 1px 2px rgba(60,64,67,.1)',
};

function InvoiceRow({ inv, onOpen, onOpenLoad, selected, onToggle }: {
  inv: ReceivableInvoice;
  onOpen: (id: string) => void;
  onOpenLoad: (inv: ReceivableInvoice) => void;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const age    = inv.agingDays;
  const stripe = age != null && age > 30 ? '#c5221f' : age != null && age > 0 ? '#e37400' : 'transparent';
  const payable = inv.balance > 0.005;
  return (
    <div onClick={() => onOpen(inv.id)}
      className="cursor-pointer"
      title="Open the invoice"
      style={{
        display: 'grid', gridTemplateColumns: GRID, gap: 10, padding: '0 14px',
        height: 40, alignItems: 'center', fontSize: 12.5,
        borderBottom: '1px solid #f1f3f4',
        boxShadow: stripe === 'transparent' ? undefined : `inset 3px 0 0 ${stripe}`,
        background: selected ? 'var(--gc-blue-light, #e8f0fe)' : undefined,
      }}
      onMouseOver={e => { if (!selected) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseOut={e => { e.currentTarget.style.background = selected ? 'var(--gc-blue-light, #e8f0fe)' : 'transparent'; }}>
      {/* Only invoices that still owe something can be marked paid, so
          settled rows get no checkbox rather than a dead one. */}
      <span onClick={e => e.stopPropagation()}>
        {payable ? (
          <input type="checkbox" checked={selected} onChange={() => onToggle(inv.id)}
            style={{ width: 15, height: 15, cursor: 'pointer' }} />
        ) : (
          <span style={{ display: 'block', width: 15, height: 15 }} />
        )}
      </span>
      <span className="tabular-nums" style={{
        textAlign: 'right', fontWeight: age != null && age > 0 ? 800 : 700, color: ageColor(age),
      }}>{ageLabel(age)}</span>
      <span onClick={e => e.stopPropagation()}>
        <CopyableCell value={inv.invoiceNumber} displayValue={inv.invoiceNumber} title="Copy invoice #" />
      </span>
      <span onClick={e => e.stopPropagation()} className="truncate">
        {inv.loadNum
          ? <CopyableLoadNum value={inv.loadNum} />
          : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
      </span>
      <button type="button"
        onClick={e => { e.stopPropagation(); if (inv.pickupEventId) onOpenLoad(inv); }}
        className="text-left font-semibold hover:underline truncate"
        style={{ color: 'var(--gc-blue)', maxWidth: '100%' }}
        title="Open load details">
        {inv.title ?? (inv.internalLoadId != null ? `#${inv.internalLoadId}` : '—')}
      </button>
      <span style={{ color: 'var(--gc-text-3)' }}>{inv.pickupAt ? shortDate(inv.pickupAt) : '—'}</span>
      <span style={{ color: 'var(--gc-text-3)' }}>{shortDate(inv.issuedAt)}</span>
      <span style={{ color: 'var(--gc-text-3)' }}>{inv.dueAt ? shortDate(inv.dueAt) : '—'}</span>
      <span className="tabular-nums" style={{ textAlign: 'right' }}>{money2(inv.total)}</span>
      <span className="tabular-nums" style={{
        textAlign: 'right', color: inv.paidAmount > 0.005 ? '#137333' : 'var(--gc-text-3)',
      }}>{inv.paidAmount > 0.005 ? money2(inv.paidAmount) : '—'}</span>
      <span className="tabular-nums" style={{ textAlign: 'right', fontWeight: 800 }}>{money2(inv.balance)}</span>
      <span style={{ textAlign: 'center' }}>
        {/* Part-paid and overdue are receivables states the invoice
            lifecycle doesn't model, so they get their own pill; anything
            else falls through to the shared StatusPill so Sent/Unsent
            read identically to Billing. */}
        {inv.paidAmount > 0.005 && inv.balance > 0.005 ? (
          <Pill bg="#e6f4ea" fg="#137333">Part paid</Pill>
        ) : age != null && age > 30 ? (
          <Pill bg="#fce8e6" fg="#c5221f">Overdue</Pill>
        ) : (
          <StatusPill status={inv.status} />
        )}
      </span>
    </div>
  );
}

function Pill({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span className="text-[10.5px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full inline-block"
      style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)' }}>{children}</span>;
}

function BillingField({ icon, label, children, grow }: {
  icon: React.ReactNode; label: string; children: React.ReactNode; grow?: boolean;
}) {
  return (
    <div style={{ minWidth: 0, flex: grow ? 1 : 'none', maxWidth: grow ? undefined : 320 }}>
      <div className="inline-flex items-center gap-1.5" style={{
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--gc-text-3)',
      }}>
        {icon}{label}
      </div>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--gc-text-2)', marginTop: 2 }}>
        {children}
      </div>
    </div>
  );
}

function Badge({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, borderRadius: 999, padding: '2px 8px',
      background: bg, color: fg, flex: 'none',
    }}>{children}</span>
  );
}

function Meta({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{icon}{children}</span>;
}

function CardTitle({ title, caption }: { title: string; caption: string }) {
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--gc-text-1)' }}>{title}</div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--gc-text-3)' }}>{caption}</div>
    </div>
  );
}

function Kpi({ label, value, valueColor, sub }: {
  label: string; value: string; valueColor: string; sub?: string;
}) {
  return (
    <div>
      <div style={{
        fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '.06em', color: 'var(--gc-text-3)',
      }}>{label}</div>
      <div className="tabular-nums" style={{ fontSize: 19, fontWeight: 800, color: valueColor }}>{value}</div>
      {sub && <div style={{ fontSize: 10.5, fontWeight: 600, color: 'var(--gc-text-3)' }}>{sub}</div>}
    </div>
  );
}

export default function CustomerReceivablesPage() {
  return (
    <RequireCap cap="receivables.access" module="receivables">
      <CustomerViewInner />
    </RequireCap>
  );
}
