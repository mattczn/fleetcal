'use client';

/**
 * /loads/[loadId] — single-load detail page.
 *
 * Layout:
 *   ┌─ Header (load id, title, billing pill, actions) ───────────────┐
 *   ├─ Left card (details) ─┬─ Top-right (route map) ────────────────┤
 *   │                       ├─ Bottom-right (billing) ──────────────┤
 *   └───────────────────────┴────────────────────────────────────────┘
 *
 * Editing model (v1):
 *   - Inline edit: Notes, Linehaul rate, Broker load #. These are the
 *     fields dispatchers most commonly tweak from a row glance; they
 *     PATCH /v1/loads/:id directly with optimistic UI.
 *   - Everything else is read-only. The big "Edit in modal" button
 *     opens the canonical EventModal — full feature parity without
 *     duplicating thousands of lines of editing logic on this page.
 *
 * Cross-page sync:
 *   Subscribes to loadEditTick so a save inside the EventModal (or
 *   anywhere else that bumps the tick) re-fetches the load here without
 *   a manual refresh. After each inline save we bumpLoadEditTick() so
 *   Accounting / Paperwork / Calendar pick up the change too.
 */

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import {
  ArrowLeft, Truck, Loader2, Pencil, MapPin, Receipt,
  ExternalLink as ExternalLinkIcon, Eye, Edit3,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import RealtimeSync from '@/components/RealtimeSync';
import EventModal from '@/components/calendar/EventModal';
import RouteMapPanel from '@/components/calendar/RouteMapPanel';
import RequireCap from '@/components/auth/RequireCap';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Load, Invoice } from '@fleetcal/types';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T'));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function fmtShortDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

interface PageProps {
  params: Promise<{ loadId: string }>;
}

export default function LoadDetailPageRoute({ params }: PageProps) {
  // Next 15 hands params as a Promise — unwrap with React's `use`.
  const { loadId } = use(params);
  return (
    <RequireCap cap="loads.view">
      <DataLoader />
      <RealtimeSync />
      <LoadDetailPage loadId={loadId} />
      <EventModal />
    </RequireCap>
  );
}

// ─── Page body ──────────────────────────────────────────────────────────

function LoadDetailPage({ loadId }: { loadId: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const customers = useCalendarStore(s => s.customers);
  const assets = useCalendarStore(s => s.assets);
  const openEditModal = useCalendarStore(s => s.openEditModal);
  const loadEditTick = useCalendarStore(s => s.loadEditTick);
  const bumpLoadEditTick = useCalendarStore(s => s.bumpLoadEditTick);

  const [legs, setLegs] = useState<Load[] | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Modal state — the View invoice button opens the existing invoice
  // detail surface so we don't duplicate the PDF/actions UI here.
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

  // Fetch the load + its active invoice. Relay loads come back with 2
  // legs (pickup + delivery). We treat the pickup leg as primary for
  // titles + display; the delivery leg surfaces beside it where relevant.
  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const loadRes = await railway.getLoad(loadId);
      if (!loadRes.loads.length) {
        setError('Load not found.');
        setLegs([]);
        return;
      }
      setLegs(loadRes.loads);
      // Invoice fetch is best-effort — a load without an invoice yet
      // is the common Released-bucket case, not an error.
      try {
        const invRes = await railway.listInvoices({ loadId });
        const nonVoid = invRes.invoices
          .filter(i => i.status !== 'void')
          .sort((a, b) => (b.issuedAt ?? '').localeCompare(a.issuedAt ?? ''));
        setInvoice(nonVoid[0] ?? null);
      } catch (e) {
        console.warn('[load detail] invoice lookup failed:', e);
        setInvoice(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [loadId]);

  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    void refresh();
  }, [authLoaded, isSignedIn, refresh]);

  // Re-sync silently when anything in the app mutates this (or any)
  // load — EventModal edits, invoice mutations, etc.
  useEffect(() => {
    if (loadEditTick === 0) return;
    void refresh({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEditTick]);

  // ── Derived primary leg + relay partner ─────────────────────────────
  const primaryLeg = useMemo<Load | undefined>(() => {
    if (!legs?.length) return undefined;
    // Pickup-role leg wins; fall back to the first event if none tagged.
    return legs.find(l => l.relayRole === 'pickup' || !l.relayRole) ?? legs[0];
  }, [legs]);
  const partnerLeg = useMemo<Load | undefined>(() => {
    if (!legs || legs.length < 2 || !primaryLeg) return undefined;
    return legs.find(l => l.id !== primaryLeg.id);
  }, [legs, primaryLeg]);

  const customerById = useMemo(() => {
    const m = new Map(customers.map(c => [c.id, c]));
    return m;
  }, [customers]);
  const assetById = useMemo(() => {
    const m = new Map(assets.map(a => [a.id, a]));
    return m;
  }, [assets]);

  const customerLabel = primaryLeg?.customerId
    ? customerById.get(primaryLeg.customerId)?.name
    : undefined;
  const brokerDisplay = displayBrokerName(
    customerLabel ?? primaryLeg?.broker ?? '',
    customers,
  );

  // ── Inline edit handlers ────────────────────────────────────────────
  //
  // Each field manages its own local edit state so a stale write
  // doesn't clobber a fresh fetch. handleSaveField PATCHes the load,
  // updates local legs[] in place, then bumps loadEditTick so other
  // pages re-sync silently.
  const saveLoadPatch = useCallback(async (patch: Parameters<typeof railway.updateLoad>[1]) => {
    if (!primaryLeg?.loadId) return;
    useCalendarStore.getState().markLoadSelfWrite(primaryLeg.loadId);
    await railway.updateLoad(primaryLeg.loadId, patch);
    // Optimistic local update — normalise nulls to undefined so the
    // patched shape stays compatible with the Load type's strict
    // `string | undefined` fields. The server treats null as "clear",
    // and undefined here just means "fell off the row" until the next
    // refetch pulls the canonical state.
    const normalised: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) normalised[k] = v ?? undefined;
    setLegs(prev => prev?.map(l => ({ ...l, ...normalised })) as Load[] | null);
    bumpLoadEditTick();
  }, [primaryLeg?.loadId, bumpLoadEditTick]);

  if (!authLoaded || !isSignedIn || (loading && !legs)) {
    return (
      <AppShell title="Load" icon={Truck} noPageScroll>
        <div className="flex-1 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
        </div>
      </AppShell>
    );
  }

  if (error || !primaryLeg) {
    return (
      <AppShell title="Load not found" icon={Truck} noPageScroll>
        <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6">
          <div className="text-[14px]" style={{ color: 'var(--gc-text-2)' }}>
            {error ?? 'This load no longer exists.'}
          </div>
          <Link href="/" className="text-[13px] font-semibold underline" style={{ color: 'var(--gc-blue)' }}>
            Back to calendar
          </Link>
        </div>
      </AppShell>
    );
  }

  const headerTitle = primaryLeg.internalLoadId
    ? `Load #${primaryLeg.internalLoadId}`
    : (primaryLeg.title ?? 'Load');

  return (
    <AppShell title={headerTitle} icon={Truck} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-2 gap-3 overflow-hidden">
        {/* ── Top toolbar ──────────────────────────────────────── */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => router.back()}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <ArrowLeft size={12} /> Back
          </button>
          <div className="flex-1" />
          <BillingPill billingStatus={primaryLeg.billingStatus} />
          <button onClick={() => openEditModal(primaryLeg.id)}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors text-white"
            style={{ background: 'var(--gc-blue)' }}>
            <Pencil size={12} /> Edit in modal
          </button>
        </div>

        {/* ── Main grid ───────────────────────────────────────── */}
        <div className="flex-1 min-h-0 grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>

          {/* Left — load details (spans both rows) */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            <DetailsHeader load={primaryLeg} brokerDisplay={brokerDisplay} />
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
              <BasicFields
                load={primaryLeg}
                partner={partnerLeg}
                assetById={assetById}
                onSavePatch={saveLoadPatch}
              />
            </div>
          </div>

          {/* Top-right — route map */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
            {primaryLeg.stops.length > 0 ? (
              <RouteMapPanel
                stops={primaryLeg.stops}
                motiveVehicleId={primaryLeg.motiveVehicleId}
                embedded
              />
            ) : (
              <EmptyMap />
            )}
          </div>

          {/* Bottom-right — billing */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)' }}>
            <BillingCard
              load={primaryLeg}
              invoice={invoice}
              onViewInvoice={() => setInvoiceModalOpen(true)}
            />
          </div>
        </div>
      </div>

      {invoiceModalOpen && invoice && (
        <InvoiceDetailModal invoiceId={invoice.id}
          onClose={() => setInvoiceModalOpen(false)} />
      )}
    </AppShell>
  );
}

// ─── Details header (sticky inside the left card) ───────────────────────

function DetailsHeader({ load, brokerDisplay }: { load: Load; brokerDisplay: string }) {
  return (
    <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0"
      style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
      <div className="flex-1 min-w-0">
        <div className="text-[15px] font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
          {load.title ?? '(untitled load)'}
        </div>
        <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
          {brokerDisplay || '(no broker)'}
          {load.loadNum ? ` · #${load.loadNum}` : ''}
        </div>
      </div>
    </div>
  );
}

// ─── Empty map placeholder ──────────────────────────────────────────────

function EmptyMap() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12"
      style={{ color: 'var(--gc-text-3)' }}>
      <MapPin size={28} className="opacity-50 mb-2" />
      <div className="text-[13px] font-semibold mb-1">No stops yet</div>
      <div className="text-[12px]">Add pickup / delivery stops to see the route.</div>
    </div>
  );
}

// ─── Billing status pill ────────────────────────────────────────────────

function BillingPill({ billingStatus }: { billingStatus?: string }) {
  const status = (billingStatus ?? 'pending') as 'pending' | 'verified' | 'invoiced' | 'paid' | 'on_hold';
  const palette: Record<typeof status, { bg: string; fg: string; border: string; label: string }> = {
    pending:  { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1', label: 'Pending' },
    verified: { bg: '#ede9fe', fg: '#5b21b6', border: '#ddd6fe', label: 'Released' },
    invoiced: { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe', label: 'Invoiced' },
    paid:     { bg: '#dcfce7', fg: '#166534', border: '#86efac', label: 'Paid' },
    on_hold:  { bg: '#fef2f2', fg: '#991b1b', border: '#fecaca', label: 'On hold' },
  };
  const p = palette[status] ?? palette.pending;
  return (
    <span className="text-[10.5px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full"
      style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
      {p.label}
    </span>
  );
}

// ─── Left-card body: load fields (read-only display + 3 inline edits) ─

function BasicFields({
  load, partner, assetById, onSavePatch,
}: {
  load: Load;
  partner: Load | undefined;
  assetById: Map<number, { id: number; name?: string | null; unit?: string | null }>;
  onSavePatch: (patch: Parameters<typeof railway.updateLoad>[1]) => Promise<void>;
}) {
  const truckLabel = (a?: { name?: string | null; unit?: string | null }) => {
    if (!a) return '';
    return `${a.name ?? ''}${a.unit ? ` #${a.unit}` : ''}`.trim();
  };
  const primaryTruck = truckLabel(assetById.get(load.assetId));
  const partnerTruck = partner ? truckLabel(assetById.get(partner.assetId)) : '';
  const drivers = [load.driverName, partner?.driverName].filter(Boolean) as string[];
  const trucks = [primaryTruck, partnerTruck].filter(Boolean);

  return (
    <>
      <Section title="Schedule">
        <Row label="Pickup"   value={fmtDateTime(load.start)} />
        <Row label="Delivery" value={fmtDateTime(partner?.end ?? load.end)} />
        <Row label="Status"   value={<StatusBadge status={load.status} />} />
      </Section>

      <Section title="Assignment">
        <Row label="Driver(s)"  value={drivers.length ? drivers.join(' / ') : <Muted>Unassigned</Muted>} />
        <Row label="Truck(s)"   value={trucks.length ? trucks.join(' / ') : <Muted>—</Muted>} />
        <Row label="Trailer"    value={load.trailerType ?? <Muted>—</Muted>} />
        <Row label="Dispatcher" value={load.dispatcher ?? <Muted>—</Muted>} />
      </Section>

      <Section title="Stops">
        {load.stops.length === 0 ? (
          <Muted>No stops added.</Muted>
        ) : (
          <div className="space-y-1.5">
            {load.stops.map((s, i) => (
              <div key={s.id} className="flex items-start gap-2 text-[12.5px]">
                <span className="font-bold tabular-nums" style={{ color: 'var(--gc-text-3)', minWidth: 18 }}>{i + 1}.</span>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
                    {s.facilityName ?? s.address ?? '(no address)'}
                  </div>
                  {s.address && s.facilityName && (
                    <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>{s.address}</div>
                  )}
                  {s.apptStart && (
                    <div className="text-[11px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                      {fmtDateTime(s.apptStart)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Reference numbers">
        {load.refNums && load.refNums.length > 0 ? (
          <div className="space-y-1">
            {load.refNums.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-[12.5px]">
                <span style={{ color: 'var(--gc-text-3)' }}>{r.label}</span>
                <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{r.value}</span>
              </div>
            ))}
          </div>
        ) : <Muted>No reference numbers.</Muted>}
      </Section>

      <Section title="Financial">
        <InlineNumberField label="Linehaul" value={load.loadPrice ?? null}
          format={(n) => moneyFmt.format(n)}
          onSave={async (v) => onSavePatch({ loadPrice: v })} />
        <InlineTextField label="Broker load #" value={load.loadNum ?? null}
          onSave={async (v) => onSavePatch({ loadNum: v ?? null })} />
        <Row label="Accessorials"
          value={
            load.accessorials && load.accessorials.length > 0 ? (
              <div className="space-y-1 text-right">
                {load.accessorials.map((a, i) => (
                  <div key={i} className="text-[12px] tabular-nums">
                    {a.category}{a.description ? ` (${a.description})` : ''} —{' '}
                    <span className="font-semibold">{moneyFmt.format(a.amount ?? 0)}</span>
                  </div>
                ))}
              </div>
            ) : <Muted>None</Muted>
          } />
        {load.totalBillable != null && load.totalBillable !== load.loadPrice && (
          <Row label="Total billable" value={
            <span className="font-extrabold tabular-nums">{moneyFmt.format(load.totalBillable)}</span>
          } />
        )}
      </Section>

      <Section title="Notes">
        <InlineTextArea value={load.notes ?? ''}
          placeholder="No notes."
          onSave={async (v) => onSavePatch({ notes: v.trim() || null })} />
      </Section>
    </>
  );
}

// ─── Layout primitives ──────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10.5px] font-bold uppercase tracking-wider mb-2"
        style={{ color: 'var(--gc-text-3)' }}>{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[12.5px] py-0.5">
      <span style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      <div className="text-right font-semibold flex-1 min-w-0" style={{ color: 'var(--gc-text-1)' }}>
        {value}
      </div>
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--gc-text-3)', fontWeight: 400 }}>{children}</span>;
}

function StatusBadge({ status }: { status: string }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    quoted:        { bg: '#f1f5f9', fg: '#475569' },
    booked:        { bg: '#eff6ff', fg: '#1d4ed8' },
    dispatched:    { bg: '#fef3c7', fg: '#92400e' },
    in_transit:    { bg: '#fef3c7', fg: '#92400e' },
    delivered:     { bg: '#dcfce7', fg: '#166534' },
    confirmed:     { bg: '#ede9fe', fg: '#5b21b6' },
    completed:     { bg: '#dcfce7', fg: '#166534' },
    cancelled:     { bg: '#fef2f2', fg: '#991b1b' },
  };
  const p = palette[status] ?? palette.booked;
  return (
    <span className="text-[10.5px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{ background: p.bg, color: p.fg }}>
      {status.replace('_', ' ')}
    </span>
  );
}

// ─── Inline editors ─────────────────────────────────────────────────────

function InlineTextField({ label, value, onSave }: {
  label: string;
  value: string | null;
  onSave: (next: string | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!editing) setDraft(value ?? ''); }, [value, editing]);

  async function commit() {
    if (busy) return;
    setBusy(true);
    try {
      const next = draft.trim();
      const persisted = value ?? '';
      if (next !== persisted) await onSave(next === '' ? null : next);
      setEditing(false);
    } catch (e) {
      console.error('[load detail] save failed:', e);
      window.alert('Failed to save. Check console for details.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Row label={label} value={
        <button onClick={() => setEditing(true)}
          className="font-semibold text-right hover:underline inline-flex items-center gap-1"
          style={{ color: value ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
          {value || 'Add'} <Edit3 size={10} style={{ opacity: 0.5 }} />
        </button>
      } />
    );
  }
  return (
    <Row label={label} value={
      <div className="flex items-center justify-end gap-1.5">
        <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={() => void commit()} disabled={busy}
          className="text-[12.5px] font-semibold text-right tabular-nums outline-none rounded px-2 py-1"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', minWidth: 100 }} />
        {busy && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
      </div>
    } />
  );
}

function InlineNumberField({ label, value, format, onSave }: {
  label: string;
  value: number | null;
  format: (n: number) => string;
  onSave: (next: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value != null ? String(value) : '');
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!editing) setDraft(value != null ? String(value) : ''); }, [value, editing]);

  async function commit() {
    if (busy) return;
    setBusy(true);
    try {
      const trimmed = draft.trim();
      const next = trimmed === '' ? null : Number(trimmed);
      if (trimmed !== '' && (isNaN(next as number) || (next as number) < 0)) {
        window.alert('Enter a non-negative number.');
        setBusy(false);
        return;
      }
      const cur = value;
      if (next !== cur) await onSave(next);
      setEditing(false);
    } catch (e) {
      console.error('[load detail] save failed:', e);
      window.alert('Failed to save. Check console for details.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <Row label={label} value={
        <button onClick={() => setEditing(true)}
          className="font-semibold text-right hover:underline inline-flex items-center gap-1 tabular-nums"
          style={{ color: value != null ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>
          {value != null ? format(value) : 'Add'} <Edit3 size={10} style={{ opacity: 0.5 }} />
        </button>
      } />
    );
  }
  return (
    <Row label={label} value={
      <div className="flex items-center justify-end gap-1.5">
        <input autoFocus type="number" value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void commit(); if (e.key === 'Escape') setEditing(false); }}
          onBlur={() => void commit()} disabled={busy}
          className="text-[12.5px] font-semibold text-right tabular-nums outline-none rounded px-2 py-1"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', width: 110 }} />
        {busy && <Loader2 size={11} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />}
      </div>
    } />
  );
}

function InlineTextArea({ value, placeholder, onSave }: {
  value: string;
  placeholder: string;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);

  async function commit() {
    if (busy) return;
    setBusy(true);
    try {
      if (draft !== value) await onSave(draft);
      setEditing(false);
    } catch (e) {
      console.error('[load detail] save failed:', e);
      window.alert('Failed to save. Check console for details.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)}
        className="text-left text-[12.5px] whitespace-pre-wrap break-words w-full p-2 rounded transition-colors"
        style={{ color: value ? 'var(--gc-text-1)' : 'var(--gc-text-3)', background: 'var(--gc-bg)', border: '1px dashed var(--gc-border)' }}>
        {value || placeholder} <Edit3 size={10} className="inline ml-1" style={{ opacity: 0.5 }} />
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <textarea autoFocus value={draft} onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setEditing(false); }}
        onBlur={() => void commit()} disabled={busy}
        rows={4}
        className="text-[12.5px] outline-none rounded p-2 resize-y"
        style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
      {busy && <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={11} className="animate-spin inline mr-1" /> Saving…
      </div>}
    </div>
  );
}

// ─── Billing card (bottom right) ────────────────────────────────────────

function BillingCard({ load, invoice, onViewInvoice }: {
  load: Load;
  invoice: Invoice | null;
  onViewInvoice: () => void;
}) {
  return (
    <>
      <div className="px-5 py-3 flex items-center gap-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
        <Receipt size={14} style={{ color: 'var(--gc-text-3)' }} />
        <span className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>Billing</span>
        <BillingPill billingStatus={load.billingStatus} />
        <div className="flex-1" />
        <Link href="/accounting"
          className="text-[11.5px] font-semibold inline-flex items-center gap-1 hover:underline"
          style={{ color: 'var(--gc-blue)' }}>
          Open in Billing <ExternalLinkIcon size={10} />
        </Link>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-3">
        {invoice ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>
                  Invoice #
                </div>
                <div className="text-[18px] font-extrabold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                  {invoice.invoiceNumber}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>
                  Total
                </div>
                <div className="text-[18px] font-extrabold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                  {moneyFmt.format(invoice.total)}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[12px]">
              <KeyVal label="Issued" value={fmtShortDate(invoice.issuedAt)} />
              <KeyVal label="Due"    value={fmtShortDate(invoice.dueAt)} />
              <KeyVal label="Paid"   value={fmtShortDate(invoice.paidAt)} />
            </div>
            <button onClick={onViewInvoice}
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
              style={{ background: 'var(--gc-bg)', color: 'var(--gc-blue)', border: '1px solid #bfdbfe' }}>
              <Eye size={12} /> View invoice packet
            </button>
          </>
        ) : (
          <div className="text-center py-6">
            <div className="text-[13px] font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>
              No invoice yet
            </div>
            <div className="text-[11.5px] mb-3" style={{ color: 'var(--gc-text-3)' }}>
              {load.billingStatus === 'verified'
                ? 'Released for billing — generate an invoice from the Billing page.'
                : load.billingStatus === 'pending'
                  ? 'Awaiting paperwork verification.'
                  : 'No invoice on file.'}
            </div>
            <Link href="/accounting"
              className="text-[12px] font-semibold inline-flex items-center gap-1 hover:underline"
              style={{ color: 'var(--gc-blue)' }}>
              Go to Billing <ExternalLinkIcon size={10} />
            </Link>
          </div>
        )}
      </div>
    </>
  );
}

function KeyVal({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-[12.5px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </div>
  );
}
