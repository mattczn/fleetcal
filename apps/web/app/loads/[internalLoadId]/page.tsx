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

  // Accent color used for the title underline + section accents.
  // EventModal pulls this from the assigned truck. Loads can have
  // multiple legs with different trucks; the accent is purely visual,
  // so we stick to a stable load-themed blue rather than chasing the
  // pickup leg's truck colour.
  const LOAD_ACCENT = 'var(--gc-blue)';

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Form pane padding mirrors EventModal: px-8 py-6 with vertical
          rhythm at space-y-5. Don't change these without lining them
          up against EventModal — the visual parity is the whole point. */}
      <div className="px-8 py-6 space-y-5">

        {/* Title row — same look as EventModal's title input:
            22px, headerColor underline, mb spacing. We use a static
            <div> instead of an <input> because there's no event title
            to edit on a load page. Falls back gracefully when the load
            has no broker. */}
        <div>
          <div
            className="w-full bg-transparent font-medium"
            style={{
              fontSize: 22,
              borderBottom: `2px solid ${LOAD_ACCENT}`,
              paddingBottom: 8,
              color: brokerDisplay ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
            }}
          >
            {brokerDisplay || 'No broker'}
          </div>
        </div>

        {/* ── Assignment ── */}
        <ModalSection title="Assignment" first>
          <div className="grid grid-cols-2 gap-4">
            <ModalField label="Driver(s)">
              <ReadValue placeholder="Unassigned">
                {drivers.length ? drivers.join(' / ') : ''}
              </ReadValue>
            </ModalField>
            <ModalField label="Truck(s)">
              <ReadValue placeholder="—">
                {trucks.length ? trucks.join(' / ') : ''}
              </ReadValue>
            </ModalField>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <ModalField label="Trailer">
              <ReadValue placeholder="—">{primary.trailerType ?? ''}</ReadValue>
            </ModalField>
            <ModalField label="Dispatcher">
              <ReadValue placeholder="—">{primary.dispatcher ?? ''}</ReadValue>
            </ModalField>
          </div>
        </ModalSection>

        {/* ── Load (broker # + cargo) ── */}
        <ModalSection title="Load">
          <div className="grid grid-cols-2 gap-4">
            <ModalField label="Broker load #">
              <ReadValue placeholder="None">{primary.loadNum ?? ''}</ReadValue>
            </ModalField>
            <ModalField label="Commodity">
              <ReadValue placeholder="—">{primary.commodity ?? ''}</ReadValue>
            </ModalField>
          </div>
          <div className="grid grid-cols-2 gap-4 mt-4">
            <ModalField label="Weight">
              <ReadValue placeholder="—">
                {primary.weight != null ? `${primary.weight.toLocaleString()} lb` : ''}
              </ReadValue>
            </ModalField>
            <div />
          </div>
        </ModalSection>

        {/* ── Reference numbers ── */}
        <ModalSection title="Reference numbers">
          {primary.refNums && primary.refNums.length > 0 ? (
            <div className="space-y-2">
              {primary.refNums.map((r, i) => (
                <div key={i} className="grid grid-cols-2 gap-4">
                  <ModalField label={r.label || 'Ref'}>
                    <ReadValue placeholder="—">{r.value}</ReadValue>
                  </ModalField>
                  <div />
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>None.</div>
          )}
        </ModalSection>

        {/* ── Stops ── */}
        <ModalSection title="Stops">
          {primary.stops.length === 0 ? (
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>No stops added.</div>
          ) : (
            <div className="space-y-3">
              {primary.stops.map((s, i) => (
                <ModalStopCard key={s.id} stop={s} index={i + 1} accent={LOAD_ACCENT} />
              ))}
            </div>
          )}
        </ModalSection>

        {/* ── Financial ── */}
        <ModalSection title="Financial">
          <div className="grid grid-cols-2 gap-4">
            <ModalField label="Linehaul">
              <ReadValue placeholder="—">
                {primary.loadPrice != null ? moneyFmt.format(primary.loadPrice) : ''}
              </ReadValue>
            </ModalField>
            {primary.totalBillable != null && primary.totalBillable !== primary.loadPrice ? (
              <ModalField label="Total billable">
                <ReadValue placeholder="—" emphasize>
                  {moneyFmt.format(primary.totalBillable)}
                </ReadValue>
              </ModalField>
            ) : <div />}
          </div>

          {/* Accessorials block — mirrors EventModal's accessorial list
              styling: each line is its own row with category + amount. */}
          <div className="mt-4">
            <div className="flex items-center gap-1.5 mb-1.5">
              <label className="text-[11px] font-semibold uppercase tracking-wider"
                style={{ color: 'var(--gc-text-3)' }}>
                Accessorials
              </label>
            </div>
            {primary.accessorials && primary.accessorials.length > 0 ? (
              <div className="space-y-1.5">
                {primary.accessorials.map((a, i) => (
                  <div key={i}
                    className="flex items-center justify-between px-3 py-2 rounded-lg"
                    style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border)' }}>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-semibold capitalize" style={{ color: 'var(--gc-text-1)' }}>
                        {a.category}
                      </div>
                      {a.description && (
                        <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)' }}>
                          {a.description}
                        </div>
                      )}
                    </div>
                    <div className="text-[13px] font-bold tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                      {moneyFmt.format(a.amount ?? 0)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>None.</div>
            )}
          </div>
        </ModalSection>

        {/* ── Notes ── */}
        <ModalSection title="Notes">
          <div
            className="text-[13px] whitespace-pre-wrap break-words rounded-lg px-3 py-2.5"
            style={{
              background: 'var(--gc-bg)',
              border: '1px solid var(--gc-border)',
              color: primary.notes ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
              minHeight: 72,
            }}>
            {primary.notes || 'No notes.'}
          </div>
        </ModalSection>
      </div>
    </div>
  );
}

// ─── EventModal-styled primitives ───────────────────────────────────────
//
// Visual parity with components/calendar/EventModal.tsx. Don't drift
// these typography choices independently — if the modal changes, mirror
// it here so the two surfaces keep feeling like the same surface.

function ModalSection({ title, first, children }: {
  title: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={first ? {} : { borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
      <div className="text-[11px] font-bold uppercase tracking-wider mb-4"
        style={{ color: 'var(--gc-text-3)' }}>
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function ModalField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <label className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--gc-text-3)' }}>
          {label}
        </label>
      </div>
      {children}
    </div>
  );
}

/** Input-shaped read-only value, styled to match EventModal's text
 *  inputs: bottom border that turns accent on focus (we leave it neutral
 *  here since it's read-only for now). Placeholder shows when empty. */
function ReadValue({
  children, placeholder, emphasize,
}: {
  children: React.ReactNode;
  placeholder?: string;
  emphasize?: boolean;
}) {
  const display = (typeof children === 'string' && children.trim() === '') ? null : children;
  return (
    <div
      className="w-full bg-transparent"
      style={{
        fontSize: emphasize ? 15 : 14,
        fontWeight: emphasize ? 700 : 500,
        borderBottom: '1px solid var(--gc-border)',
        paddingBottom: 6,
        paddingTop: 2,
        color: display != null ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
        minHeight: 24,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {display ?? placeholder ?? '—'}
    </div>
  );
}

/** Stop card — mimics the per-stop block style in EventModal's stops
 *  section: rounded card, accent-tinted left border, stop number, name,
 *  address, appt window, and a Geocoded badge when lat/lng land. */
function ModalStopCard({ stop, index, accent }: {
  stop: Stop;
  index: number;
  accent: string;
}) {
  const hasGeo = stop.lat != null && stop.lng != null;
  return (
    <div
      className="rounded-lg px-3 py-2.5 flex items-start gap-3"
      style={{
        background: 'var(--gc-bg)',
        border: '1px solid var(--gc-border)',
        borderLeft: `3px solid ${accent}`,
      }}>
      <div
        className="flex items-center justify-center rounded-full text-[11px] font-extrabold tabular-nums shrink-0"
        style={{
          width: 22, height: 22,
          background: accent, color: '#fff',
        }}>
        {index}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate" style={{ color: 'var(--gc-text-1)', fontSize: 13 }}>
            {stop.facilityName ?? stop.address ?? '(no address)'}
          </span>
          <span className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
            style={{
              background: hasGeo ? '#dcfce7' : '#fef2f2',
              color:      hasGeo ? '#166534' : '#991b1b',
              border:     `1px solid ${hasGeo ? '#86efac' : '#fecaca'}`,
            }}
            title={hasGeo
              ? `Lat ${stop.lat?.toFixed(4)}, Lng ${stop.lng?.toFixed(4)}`
              : 'No coordinates — geocode pending'}>
            {hasGeo ? 'Geocoded' : 'No geo'}
          </span>
        </div>
        {stop.address && stop.facilityName && (
          <div className="text-[11.5px] truncate" style={{ color: 'var(--gc-text-3)', marginTop: 2 }}>
            {stop.address}
          </div>
        )}
        {stop.apptStart && (
          <div className="text-[11.5px] tabular-nums" style={{ color: 'var(--gc-text-3)', marginTop: 2 }}>
            {fmtStopWindow(stop)}
          </div>
        )}
      </div>
    </div>
  );
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
