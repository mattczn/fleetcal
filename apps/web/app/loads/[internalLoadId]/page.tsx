'use client';

/**
 * /loads/[internalLoadId] — single-load detail page.
 *
 * Visually mirrors EventModal's form pane field-for-field. Same
 * Field wrapper, same input styling (border, padding, font-size that
 * tracks --ui-scale), same StyledSelect for dropdowns, same section
 * dividers, same title-input look.
 *
 * What's missing vs EventModal (deliberately): event start/end
 * timestamps, revenue / non-revenue tags, map and docs toggles,
 * "view load details" affordance. Those concepts belong on the
 * event surface, not on a load page.
 *
 * Layout:
 *   ┌─ Top toolbar ──────────────────────────────────────────────────┐
 *   ├─ Left card (load fields, modal-styled) ─┬─ Top-right (map) ───┤
 *   │                                         ├─ Bottom-right (bill)┤
 *   └─────────────────────────────────────────┴────────────────────┘
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
import { StyledSelect } from '@/components/ui/StyledSelect';
import {
  inputStyle, focusColor, blurColor, Field, ModalSection,
} from '@/components/forms/EventModalForm';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Load, Invoice, Stop } from '@fleetcal/types';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Same accent the calendar uses for revenue loads. Hard-coded here
 *  because the load page isn't tied to a single truck's color. */
const LOAD_ACCENT = '#1a73e8';

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
  const { internalLoadId } = use(params);
  return (
    <RequireCap cap="loads.view">
      <DataLoader />
      <RealtimeSync />
      <LoadDetailPage internalLoadId={internalLoadId} />
    </RequireCap>
  );
}

function LoadDetailPage({ internalLoadId }: { internalLoadId: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const customers = useCalendarStore(s => s.customers);
  const assets = useCalendarStore(s => s.assets);
  const drivers = useCalendarStore(s => s.drivers);
  const cardFontScale = useCalendarStore(s => s.cardFontScale);
  const loadEditTick = useCalendarStore(s => s.loadEditTick);

  const [legs, setLegs] = useState<Load[] | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

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
      try {
        const loadId = loadRes.loads[0]?.loadId;
        if (!loadId) { setInvoice(null); return; }
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

  useEffect(() => {
    if (loadEditTick === 0) return;
    void refresh({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEditTick]);

  const primaryLeg = useMemo<Load | undefined>(() => {
    if (!legs?.length) return undefined;
    return legs.find(l => l.relayRole === 'pickup' || !l.relayRole) ?? legs[0];
  }, [legs]);
  const partnerLeg = useMemo<Load | undefined>(() => {
    if (!legs || legs.length < 2 || !primaryLeg) return undefined;
    return legs.find(l => l.id !== primaryLeg.id);
  }, [legs, primaryLeg]);

  const customerById = useMemo(() => new Map(customers.map(c => [c.id, c])), [customers]);

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
        {/* Top toolbar */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => router.back()}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <ArrowLeft size={12} /> Back
          </button>
          <div className="flex-1" />
        </div>

        <div className="flex-1 min-h-0 grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>

          {/* Left — load fields, modal-styled */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            {/* ui-scale-scope: inherits Settings → Appearance → "Calendar
                card text" sizing, exactly like EventModal does. */}
            <div className="ui-scale-scope flex-1 min-h-0 overflow-y-auto"
              style={{ ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1 } as React.CSSProperties}>
              <fieldset disabled style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                <LoadFormPane
                  primary={primaryLeg}
                  partner={partnerLeg}
                  customerById={customerById}
                  assets={assets}
                  drivers={drivers}
                  customers={customers}
                />
              </fieldset>
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
              <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-12"
                style={{ color: 'var(--gc-text-3)' }}>
                <MapPin size={28} className="opacity-50 mb-2" />
                <div className="text-[13px] font-semibold mb-1">No stops yet</div>
                <div className="text-[12px]">Add pickup / delivery stops to see the route.</div>
              </div>
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

// ─── Left card — modal-styled form ──────────────────────────────────────

function LoadFormPane({
  primary, partner, customerById, assets, drivers, customers,
}: {
  primary: Load;
  partner: Load | undefined;
  customerById: Map<string, { id: string; name: string }>;
  assets: { id: number; name?: string | null; unit?: string | null }[];
  drivers: { id?: number; name?: string; firstName?: string; lastName?: string }[];
  customers: { name: string; aliases?: string[] }[];
}) {
  const iStyle = inputStyle();
  const focusH = focusColor(LOAD_ACCENT);

  // ── Derived values ──────────────────────────────────────────────────
  const customerLabel = primary.customerId
    ? customerById.get(primary.customerId)?.name
    : undefined;
  const brokerDisplay = displayBrokerName(
    customerLabel ?? primary.broker ?? '',
    customers as Parameters<typeof displayBrokerName>[1],
  );

  const assetById = new Map(assets.map(a => [a.id, a]));
  const truckLabel = (a?: { name?: string | null; unit?: string | null }) =>
    a ? `${a.name ?? ''}${a.unit ? ` #${a.unit}` : ''}`.trim() : '';

  const primaryTruckLabel = truckLabel(assetById.get(primary.assetId));
  const partnerTruckLabel = partner ? truckLabel(assetById.get(partner.assetId)) : '';

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="px-8 py-6 space-y-5">

      {/* Title row — same look as EventModal's title input.
          Static text styled to read like the input it would have been
          on the event surface. Underline uses LOAD_ACCENT. */}
      <input
        type="text"
        value={brokerDisplay || ''}
        readOnly
        placeholder="No broker"
        className="w-full bg-transparent outline-none font-medium"
        style={{
          fontSize: 22,
          borderBottom: `2px solid ${LOAD_ACCENT}`,
          paddingBottom: 8,
          color: 'var(--gc-text-1)',
          cursor: 'default',
        }}
      />

      {/* ── Assignment ── */}
      <ModalSection title="Assignment" first>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Driver">
            <StyledSelect
              value={primary.driverName ?? ''}
              onChange={() => { /* read-only on detail page */ }}
              style={{ ...iStyle, cursor: 'pointer' }}
              onFocus={focusH} onBlur={blurColor}>
              <option value="">— No driver —</option>
              {primary.driverName && (
                <option value={primary.driverName}>{primary.driverName}</option>
              )}
              {drivers.map(d => {
                const name = d.name ?? `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim();
                if (!name || name === primary.driverName) return null;
                return <option key={d.id ?? name} value={name}>{name}</option>;
              })}
            </StyledSelect>
          </Field>
          <Field label="Truck">
            <StyledSelect
              value={String(primary.assetId ?? '')}
              onChange={() => { /* read-only */ }}
              style={{ ...iStyle, cursor: 'pointer' }}
              onFocus={focusH} onBlur={blurColor}>
              <option value="">— No truck —</option>
              {assets.map(a => (
                <option key={a.id} value={String(a.id)}>{truckLabel(a)}</option>
              ))}
            </StyledSelect>
          </Field>
        </div>

        {partner && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <Field label="Delivery driver (relay)">
              <input type="text" value={partner.driverName ?? ''} readOnly
                placeholder="Unassigned"
                style={iStyle} onFocus={focusH} onBlur={blurColor} />
            </Field>
            <Field label="Delivery truck (relay)">
              <input type="text" value={partnerTruckLabel} readOnly
                placeholder="—"
                style={iStyle} onFocus={focusH} onBlur={blurColor} />
            </Field>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label="Trailer type">
            <input type="text" value={primary.trailerType ?? ''} readOnly
              placeholder="—"
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
          </Field>
          <Field label="Dispatcher">
            <input type="text" value={primary.dispatcher ?? ''} readOnly
              placeholder="—"
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
          </Field>
        </div>
      </ModalSection>

      {/* ── Load info ── */}
      <ModalSection title="Load">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Broker load #">
            <input type="text" value={primary.loadNum ?? ''} readOnly
              placeholder="None"
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
          </Field>
          <Field label="Commodity">
            <input type="text" value={primary.commodity ?? ''} readOnly
              placeholder="—"
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4">
          <Field label="Weight (lb)">
            <input type="text"
              value={primary.weight != null ? primary.weight.toLocaleString() : ''}
              readOnly placeholder="—"
              style={{ ...iStyle, fontVariantNumeric: 'tabular-nums' }}
              onFocus={focusH} onBlur={blurColor} />
          </Field>
          <div />
        </div>
      </ModalSection>

      {/* ── Reference numbers ── */}
      <ModalSection title="Reference numbers">
        {primary.refNums && primary.refNums.length > 0 ? (
          <div className="space-y-3">
            {primary.refNums.map((r, i) => (
              <div key={i} className="grid grid-cols-2 gap-4">
                <Field label={r.label || `Ref ${i + 1}`}>
                  <input type="text" value={r.value} readOnly
                    style={{ ...iStyle, fontVariantNumeric: 'tabular-nums' }}
                    onFocus={focusH} onBlur={blurColor} />
                </Field>
                <div />
              </div>
            ))}
          </div>
        ) : (
          <div style={{ ...iStyle, color: 'var(--gc-text-3)', display: 'flex', alignItems: 'center' }}>
            None.
          </div>
        )}
      </ModalSection>

      {/* ── Stops ── */}
      <ModalSection title="Stops">
        {primary.stops.length === 0 ? (
          <div style={{ ...iStyle, color: 'var(--gc-text-3)', display: 'flex', alignItems: 'center' }}>
            No stops added.
          </div>
        ) : (
          <div className="space-y-2">
            {primary.stops.map((s, i) => (
              <StopCard key={s.id} stop={s} index={i + 1} accent={LOAD_ACCENT} />
            ))}
          </div>
        )}
      </ModalSection>

      {/* ── Financial ── */}
      <ModalSection title="Financial">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Linehaul">
            <input type="text"
              value={primary.loadPrice != null ? moneyFmt.format(primary.loadPrice) : ''}
              readOnly placeholder="—"
              style={{ ...iStyle, fontVariantNumeric: 'tabular-nums' }}
              onFocus={focusH} onBlur={blurColor} />
          </Field>
          <Field label="Total billable">
            <input type="text"
              value={primary.totalBillable != null ? moneyFmt.format(primary.totalBillable) : ''}
              readOnly placeholder="—"
              style={{ ...iStyle, fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}
              onFocus={focusH} onBlur={blurColor} />
          </Field>
        </div>

        <div className="mt-4">
          <Field label="Accessorials">
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
              <div style={{ ...iStyle, color: 'var(--gc-text-3)', display: 'flex', alignItems: 'center' }}>
                None.
              </div>
            )}
          </Field>
        </div>
      </ModalSection>

      {/* ── Notes ── */}
      <ModalSection title="Notes">
        <textarea
          value={primary.notes ?? ''}
          readOnly placeholder="No notes."
          rows={4}
          style={{ ...iStyle, resize: 'none', fontFamily: 'inherit', minHeight: 88 }}
          onFocus={focusH} onBlur={blurColor}
        />
      </ModalSection>
    </div>
  );
}

// ─── Stop card ──────────────────────────────────────────────────────────
//
// Visual structure mirrors StopsSection's per-stop block: rounded card,
// accent left border, numbered chip, facility/address text stack, plus
// a Geocoded badge that turns red when lat/lng haven't landed.

function StopCard({ stop, index, accent }: {
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
        className="flex items-center justify-center rounded-full font-extrabold tabular-nums shrink-0"
        style={{
          width: 22, height: 22,
          background: accent, color: '#fff',
          fontSize: 11,
        }}>
        {index}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold truncate" style={{ color: 'var(--gc-text-1)', fontSize: 13 }}>
            {stop.facilityName ?? stop.address ?? '(no address)'}
          </span>
          <span className="font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
            style={{
              fontSize: 9.5,
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
          <div className="truncate" style={{ color: 'var(--gc-text-3)', fontSize: 11.5, marginTop: 2 }}>
            {stop.address}
          </div>
        )}
        {stop.apptStart && (
          <div className="tabular-nums" style={{ color: 'var(--gc-text-3)', fontSize: 11.5, marginTop: 2 }}>
            {fmtStopWindow(stop)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Billing card (bottom right) ────────────────────────────────────────

function BillingCard({ load, invoice, onViewInvoice }: {
  load: Load;
  invoice: Invoice | null;
  onViewInvoice: () => void;
}) {
  const status = load.billingStatus ?? 'pending';
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
