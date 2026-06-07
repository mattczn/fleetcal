'use client';

/**
 * /loads/[internalLoadId] — single-load detail page.
 *
 * Load-centric (NOT event-centric):
 *   We fetch the load by its org-scoped internal_load_id (the "#10761"
 *   the dispatcher already knows) and display load-table fields.
 *   Event-level concepts — pickup/delivery start/end timestamps, the
 *   revenue / non-revenue distinction, per-event Map / Docs toggles,
 *   the "view load details" affordance — don't belong on this surface
 *   and are explicitly excluded.
 *
 * Layout:
 *   ┌─ Top toolbar ──────────────────────────────────────────────────┐
 *   ├─ Left card (load details) ───┬─ Top-right (route map) ────────┤
 *   │                              ├─ Bottom-right (billing) ──────┤
 *   └──────────────────────────────┴───────────────────────────────┘
 *
 * Cross-page sync:
 *   Subscribes to loadEditTick so edits made anywhere else in the app
 *   (EventModal saves, invoice mutations, etc.) refetch the load
 *   silently.
 */

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import {
  ArrowLeft, Truck, Loader2, Receipt, MapPin,
  ExternalLink as ExternalLinkIcon, Eye, FileCheck2,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import RealtimeSync from '@/components/RealtimeSync';
import RouteMapPanel from '@/components/calendar/RouteMapPanel';
import RequireCap from '@/components/auth/RequireCap';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Load, Invoice, Stop } from '@fleetcal/types';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function fmtShortDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtStopWindow(s: Stop): string {
  if (!s.apptStart) return '';
  const d = new Date(s.apptStart);
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} · ${time}`;
}

interface PageProps {
  params: Promise<{ internalLoadId: string }>;
}

export default function LoadDetailPageRoute({ params }: PageProps) {
  // Next 15 hands params as a Promise — unwrap with React's `use`.
  const { internalLoadId } = use(params);
  return (
    <RequireCap cap="loads.view">
      <DataLoader />
      <RealtimeSync />
      <LoadDetailPage internalLoadId={internalLoadId} />
    </RequireCap>
  );
}

// ─── Page body ──────────────────────────────────────────────────────────

function LoadDetailPage({ internalLoadId }: { internalLoadId: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const customers = useCalendarStore(s => s.customers);
  const assets = useCalendarStore(s => s.assets);
  const loadEditTick = useCalendarStore(s => s.loadEditTick);

  const [legs, setLegs] = useState<Load[] | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

  // Validate slug + fetch the load by internal_load_id. The API endpoint
  // does the uuid lookup server-side; from the client's perspective
  // it's a single round trip keyed by the human-readable number.
  const internalIdNum = useMemo(() => {
    const n = Number.parseInt(internalLoadId, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [internalLoadId]);

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    if (internalIdNum == null) {
      setError(`"${internalLoadId}" is not a valid load ID.`);
      setLoading(false);
      return;
    }
    if (!opts?.silent) setLoading(true);
    setError(null);
    try {
      const loadRes = await railway.getLoadByInternalId(internalIdNum);
      if (!loadRes.loads.length) {
        setError(`Load #${internalIdNum} not found.`);
        setLegs([]);
        return;
      }
      setLegs(loadRes.loads);
      // Active invoice — best-effort lookup. Released loads with no
      // invoice yet are the common case, not an error. Need the
      // load's uuid (loadId) to filter.
      try {
        const loadId = loadRes.loads[0]?.loadId;
        if (!loadId) {
          setInvoice(null);
          return;
        }
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
  }, [internalLoadId, internalIdNum]);

  useEffect(() => {
    if (!authLoaded || !isSignedIn) return;
    void refresh();
  }, [authLoaded, isSignedIn, refresh]);

  // Cross-page sync: refetch silently after any mutation elsewhere.
  useEffect(() => {
    if (loadEditTick === 0) return;
    void refresh({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEditTick]);

  // Primary leg = pickup-role (or single leg). Relay loads come back
  // with two legs; we treat the pickup as canonical for load-level
  // fields and merge driver/truck info from both for display.
  const primaryLeg = useMemo<Load | undefined>(() => {
    if (!legs?.length) return undefined;
    return legs.find(l => l.relayRole === 'pickup' || !l.relayRole) ?? legs[0];
  }, [legs]);
  const partnerLeg = useMemo<Load | undefined>(() => {
    if (!legs || legs.length < 2 || !primaryLeg) return undefined;
    return legs.find(l => l.id !== primaryLeg.id);
  }, [legs, primaryLeg]);

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);
  const assetById = useMemo(() => new Map(assets.map(a => [a.id, a])), [assets]);

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

  const headerTitle = `Load #${primaryLeg.internalLoadId ?? internalLoadId}`;

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
        </div>

        {/* ── Main grid ───────────────────────────────────────── */}
        <div className="flex-1 min-h-0 grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>

          {/* Left — load detail fields */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            <LoadDetailsCard
              primary={primaryLeg}
              partner={partnerLeg}
              customerById={customerById}
              assetById={assetById}
              customers={customers}
            />
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
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12"
                style={{ color: 'var(--gc-text-3)' }}>
                <MapPin size={28} className="opacity-50 mb-2" />
                <div className="text-[13px] font-semibold mb-1">No stops yet</div>
                <div className="text-[12px]">Add pickup / delivery stops to see the route.</div>
              </div>
            )}
          </div>

          {/* Bottom-right — billing (status + actions all live here) */}
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

// ─── Left card — load-level fields only ─────────────────────────────────

function LoadDetailsCard({
  primary, partner, customerById, assetById, customers,
}: {
  primary: Load;
  partner: Load | undefined;
  customerById: Map<string, { id: string; name: string }>;
  assetById: Map<number, { id: number; name?: string | null; unit?: string | null }>;
  customers: { name: string; aliases?: string[] }[];
}) {
  const customerLabel = primary.customerId
    ? customerById.get(primary.customerId)?.name
    : undefined;
  const brokerDisplay = displayBrokerName(
    customerLabel ?? primary.broker ?? '',
    customers as Parameters<typeof displayBrokerName>[1],
  );

  const truckLabel = (a?: { name?: string | null; unit?: string | null }) => {
    if (!a) return '';
    return `${a.name ?? ''}${a.unit ? ` #${a.unit}` : ''}`.trim();
  };
  const primaryTruck = truckLabel(assetById.get(primary.assetId));
  const partnerTruck = partner ? truckLabel(assetById.get(partner.assetId)) : '';
  // Drivers + trucks aggregated from the leg(s) — these are event-table
  // joins, but we surface them here because the load page is the
  // operator's "who's hauling this" answer. NOT the same as event
  // start/end times, which are out of scope for this page.
  const drivers = [primary.driverName, partner?.driverName].filter(Boolean) as string[];
  const trucks = [primaryTruck, partnerTruck].filter(Boolean);

  return (
    <>
      <div className="px-5 py-3 flex items-center gap-3 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-extrabold truncate" style={{ color: 'var(--gc-text-1)' }}>
            {brokerDisplay || '(no broker)'}
          </div>
          <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
            {primary.loadNum ? `Broker load #${primary.loadNum}` : 'No broker load #'}
          </div>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
        <Section title="Assignment">
          <Row label="Driver(s)"   value={drivers.length ? drivers.join(' / ') : <Muted>Unassigned</Muted>} />
          <Row label="Truck(s)"    value={trucks.length ? trucks.join(' / ') : <Muted>—</Muted>} />
          <Row label="Trailer"     value={primary.trailerType ?? <Muted>—</Muted>} />
          <Row label="Dispatcher"  value={primary.dispatcher ?? <Muted>—</Muted>} />
        </Section>

        <Section title="Stops">
          {primary.stops.length === 0 ? (
            <Muted>No stops added.</Muted>
          ) : (
            <div className="space-y-2">
              {primary.stops.map((s, i) => (
                <StopRow key={s.id} stop={s} index={i + 1} />
              ))}
            </div>
          )}
        </Section>

        <Section title="Reference numbers">
          {primary.refNums && primary.refNums.length > 0 ? (
            <div className="space-y-1">
              {primary.refNums.map((r, i) => (
                <div key={i} className="flex items-center justify-between text-[12.5px]">
                  <span style={{ color: 'var(--gc-text-3)' }}>{r.label}</span>
                  <span className="font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{r.value}</span>
                </div>
              ))}
            </div>
          ) : <Muted>None.</Muted>}
        </Section>

        <Section title="Cargo">
          <Row label="Commodity" value={primary.commodity ?? <Muted>—</Muted>} />
          <Row label="Weight"
            value={primary.weight != null
              ? <span className="tabular-nums">{primary.weight.toLocaleString()} lb</span>
              : <Muted>—</Muted>} />
        </Section>

        <Section title="Financial">
          <Row label="Linehaul"
            value={primary.loadPrice != null
              ? <span className="font-semibold tabular-nums">{moneyFmt.format(primary.loadPrice)}</span>
              : <Muted>—</Muted>} />
          <Row label="Accessorials"
            value={
              primary.accessorials && primary.accessorials.length > 0 ? (
                <div className="space-y-1 text-right">
                  {primary.accessorials.map((a, i) => (
                    <div key={i} className="text-[12px] tabular-nums">
                      {a.category}{a.description ? ` (${a.description})` : ''} —{' '}
                      <span className="font-semibold">{moneyFmt.format(a.amount ?? 0)}</span>
                    </div>
                  ))}
                </div>
              ) : <Muted>None</Muted>
            } />
          {primary.totalBillable != null && primary.totalBillable !== primary.loadPrice && (
            <Row label="Total billable"
              value={<span className="font-extrabold tabular-nums">{moneyFmt.format(primary.totalBillable)}</span>} />
          )}
        </Section>

        <Section title="Notes">
          <div className="text-[12.5px] whitespace-pre-wrap break-words p-2 rounded"
            style={{
              background: 'var(--gc-bg)',
              border: '1px solid var(--gc-border)',
              color: primary.notes ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
              minHeight: 60,
            }}>
            {primary.notes || 'No notes.'}
          </div>
        </Section>
      </div>
    </>
  );
}

function StopRow({ stop, index }: { stop: Stop; index: number }) {
  const hasGeo = stop.lat != null && stop.lng != null;
  return (
    <div className="flex items-start gap-2 text-[12.5px]">
      <span className="font-bold tabular-nums" style={{ color: 'var(--gc-text-3)', minWidth: 18 }}>{index}.</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>
            {stop.facilityName ?? stop.address ?? '(no address)'}
          </span>
          {hasGeo && (
            <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac' }}
              title={`Lat ${stop.lat?.toFixed(4)}, Lng ${stop.lng?.toFixed(4)}`}>
              Geocoded
            </span>
          )}
        </div>
        {stop.address && stop.facilityName && (
          <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>{stop.address}</div>
        )}
        {stop.apptStart && (
          <div className="text-[11px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
            {fmtStopWindow(stop)}
          </div>
        )}
      </div>
    </div>
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

// ─── Billing card (bottom right) ────────────────────────────────────────
//
// All billing affordances live here: status pill, invoice number/total,
// View invoice packet, Open in Paperwork (review queue), Open in Billing.
// Nothing billing-related belongs in the toolbar or the load detail card.

function BillingCard({ load, invoice, onViewInvoice }: {
  load: Load;
  invoice: Invoice | null;
  onViewInvoice: () => void;
}) {
  const status = load.billingStatus ?? 'pending';
  // Paperwork's review queue is event-keyed via the /closeout route +
  // tab; deep-linking to a single load isn't exposed yet, so we send
  // operators to Paperwork's All bucket where they can search. When a
  // load is paid, the review queue is no longer useful — drop it.
  const showReviewQueueLink = status === 'pending' || status === 'verified' || status === 'invoiced';

  return (
    <>
      <div className="px-5 py-3 flex items-center gap-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
        <Receipt size={14} style={{ color: 'var(--gc-text-3)' }} />
        <span className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>Billing</span>
        <BillingPill billingStatus={status} />
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
          </>
        ) : (
          <div className="text-center py-2">
            <div className="text-[13px] font-semibold mb-0.5" style={{ color: 'var(--gc-text-1)' }}>
              No invoice yet
            </div>
            <div className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
              {status === 'verified'
                ? 'Released for billing — generate an invoice from Billing.'
                : status === 'pending'
                  ? 'Awaiting paperwork verification.'
                  : 'No invoice on file.'}
            </div>
          </div>
        )}

        {/* Action buttons — all billing-related navigation lives here */}
        <div className="space-y-1.5 pt-1">
          {invoice && (
            <button onClick={onViewInvoice}
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
              style={{ background: 'var(--gc-bg)', color: 'var(--gc-blue)', border: '1px solid #bfdbfe' }}>
              <Eye size={12} /> View invoice packet
            </button>
          )}
          {showReviewQueueLink && (
            <Link href="/closeout"
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
              style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
              <FileCheck2 size={12} /> Open in Paperwork
            </Link>
          )}
          <Link href="/accounting"
            className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
            <ExternalLinkIcon size={12} /> Open in Billing
          </Link>
        </div>
      </div>
    </>
  );
}

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

function KeyVal({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="text-[12.5px] font-semibold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>{value}</div>
    </div>
  );
}
