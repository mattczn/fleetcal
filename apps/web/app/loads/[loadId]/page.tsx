'use client';

/**
 * /loads/[loadId] — single-load detail page.
 *
 * Layout:
 *   ┌─ Top toolbar ──────────────────────────────────────────────────┐
 *   ├─ Left card (EventModal embedded) ─┬─ Top-right (route map) ───┤
 *   │                                   ├─ Bottom-right (billing) ──┤
 *   └───────────────────────────────────┴───────────────────────────┘
 *
 * Editing model:
 *   The left card mounts <EventModal embedded /> — the exact same form
 *   the calendar pops up, just rendered inline in a page card instead
 *   of as a centered overlay. Field types, date/time pickers,
 *   accessorials editor, stops editor with geocode validation, save/
 *   discard flow, font-size scaling — all identical, because it's
 *   literally the same component.
 *
 * The page-level Map and Billing cards live on the right. The modal's
 * own Map and PDF side-panes are suppressed in embedded mode (see
 * EventModal's `embedded` prop) so we don't double-render the map.
 *
 * Cross-page sync:
 *   Subscribes to loadEditTick so saves inside the embedded modal
 *   (and any other source) re-fetch the page's invoice + billing
 *   state silently.
 */

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@clerk/nextjs';
import {
  ArrowLeft, Truck, Loader2, Receipt,
  ExternalLink as ExternalLinkIcon, Eye,
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
import type { Load, Invoice } from '@fleetcal/types';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

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
    </RequireCap>
  );
}

// ─── Page body ──────────────────────────────────────────────────────────

function LoadDetailPage({ loadId }: { loadId: string }) {
  const router = useRouter();
  const { isLoaded: authLoaded, isSignedIn } = useAuth();
  const openEditModal = useCalendarStore(s => s.openEditModal);
  const loadEditTick = useCalendarStore(s => s.loadEditTick);

  const [legs, setLegs] = useState<Load[] | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The View invoice button opens the existing invoice detail surface
  // so we don't duplicate the PDF/actions UI here.
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);

  // Fetch the load + its active invoice. Relay loads come back with
  // two legs (pickup + delivery); we use the pickup leg as primary.
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
  // load — embedded modal saves, invoice mutations, etc.
  useEffect(() => {
    if (loadEditTick === 0) return;
    void refresh({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadEditTick]);

  // Pick the primary (pickup) leg — same logic the calendar uses.
  const primaryLeg = useMemo<Load | undefined>(() => {
    if (!legs?.length) return undefined;
    return legs.find(l => l.relayRole === 'pickup' || !l.relayRole) ?? legs[0];
  }, [legs]);

  // Open the embedded modal on first paint so the form renders. The
  // EventModal's internal `modalOpen` state is what controls whether
  // its JSX renders; openEditModal flips it on. Without this the page
  // shows an empty left card.
  const [autoOpenedFor, setAutoOpenedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!primaryLeg?.id) return;
    if (autoOpenedFor === primaryLeg.id) return;
    openEditModal(primaryLeg.id);
    setAutoOpenedFor(primaryLeg.id);
  }, [primaryLeg?.id, autoOpenedFor, openEditModal]);

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
        </div>

        {/* ── Main grid ───────────────────────────────────────── */}
        <div className="flex-1 min-h-0 grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>

          {/* Left — EventModal embedded (spans both rows). All editing
              fields, date/time pickers, accessorials editor, stops
              editor with geocode validation, font-size scaling. Save
              + Discard live inside the modal's own footer (we'll lift
              them to the page toolbar in a follow-up). */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            <EventModal embedded />
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
                <div className="text-[13px] font-semibold mb-1">No stops yet</div>
                <div className="text-[12px]">Add pickup / delivery stops to see the route.</div>
              </div>
            )}
          </div>

          {/* Bottom-right — billing (intentionally minimal v1: status
              pill, invoice essentials, view-invoice button. Will grow
              into a fuller billing surface in follow-ups). */}
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
