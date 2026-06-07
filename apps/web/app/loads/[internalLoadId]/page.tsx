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

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth, useUser } from '@clerk/nextjs';
import {
  ArrowLeft, Truck, Loader2, Receipt, MapPin,
  ExternalLink as ExternalLinkIcon, Eye,
  CheckCircle2, Plus, Clock, Copy, RotateCcw, Calendar as CalendarIcon,
  Info, Pin, X, Star, Lock, ClipboardCheck, FolderOpen,
  Send, Mail, Globe, FilePlus, RefreshCw, Check, AlertTriangle,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import DataLoader from '@/components/DataLoader';
import RealtimeSync from '@/components/RealtimeSync';
import RouteMapPanel from '@/components/calendar/RouteMapPanel';
import StopsSection from '@/components/calendar/StopsSection';
import CheckCallsSection from '@/components/calendar/CheckCallsSection';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import RequireCap from '@/components/auth/RequireCap';
import { InvoiceDetailModal } from '@/components/invoicing/InvoiceDetailModal';
import { StyledSelect } from '@/components/ui/StyledSelect';
import {
  inputStyle, focusColor, blurColor, Field, ModalSection,
  DriverPhoneCopy, RefNumsField,
} from '@/components/forms/EventModalForm';
import { CustomerCombobox } from '@/components/forms/CustomerCombobox';
import { NewBrokerReviewModal } from '@/components/calendar/NewBrokerReviewModal';
import ReviewQueue from '@/components/closeout/ReviewQueue';
import FinalizedPayBanner from '@/components/payroll/FinalizedPayBanner';
import { useLoadPayFinalized } from '@/lib/useLoadPayFinalized';
import { LOAD_ACCENT_BG, LOAD_ACCENT_BORDER } from '@/lib/loadAccent';
import {
  SECTION_LABELS, getEnabledFieldsForSection,
  type FieldSection, type FieldDef,
} from '@/lib/fields';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Load, Invoice, Customer, InternalNote, LoadStatus } from '@fleetcal/types';

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Same accent the calendar uses for revenue loads. Hard-coded here
 *  because the load page isn't tied to a single truck's color. */
const LOAD_ACCENT = '#1a73e8';

/**
 * Tiny copy-to-clipboard button. Mirrors EventModal's `CopyLabelBtn`
 * pixel-for-pixel — same 20×20 box, same bordered surface, same
 * 1.5-second green check flash on success. Used inline next to the
 * Load # input and each reference value so dispatchers can grab the
 * digits without highlight-and-cmd-c.
 */
/**
 * Compact inline copy button, sized to sit beside a small uppercase
 * field label. Same flash semantics as CopyBtn — 1.5s green check on
 * success — but the smaller box (18px) keeps the label row tight.
 */
function CopyBtnInline({ value, title = 'Copy' }: { value: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  function onClick() {
    if (!value || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button type="button" onClick={onClick}
      title={copied ? 'Copied!' : title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
        cursor: value ? 'pointer' : 'default',
        border: 'none', background: 'transparent',
        color: copied ? '#15803d' : 'var(--gc-text-3)',
        transition: 'color 120ms, background 120ms',
        opacity: value ? 1 : 0.4,
      }}
      onMouseEnter={e => { if (!copied && value) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'transparent'; }}>
      {copied ? <CheckCircle2 size={11} /> : <Copy size={11} />}
    </button>
  );
}

function fmtShortDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  const { user } = useUser();
  const currentUserName = user?.fullName ?? user?.firstName ?? 'Unknown';
  const customers = useCalendarStore(s => s.customers);
  const addCustomer = useCalendarStore(s => s.addCustomer);
  const assets = useCalendarStore(s => s.assets);
  const drivers = useCalendarStore(s => s.drivers);
  const cardFontScale = useCalendarStore(s => s.cardFontScale);
  const calendarTimezone = useCalendarStore(s => s.calendarTimezone);
  const driverPayPct = useCalendarStore(s => s.driverPayPct);
  const loadEditTick = useCalendarStore(s => s.loadEditTick);
  const bumpLoadEditTick = useCalendarStore(s => s.bumpLoadEditTick);
  // sectionOrder + fieldSettings live in Settings → Appearance →
  // Calendar form fields. Mirroring them here keeps the load page in
  // sync with whatever the operator has configured for EventModal —
  // they don't need to maintain two configs.
  const sectionOrder = useCalendarStore(s => s.sectionOrder);
  const fieldSettings = useCalendarStore(s => s.fieldSettings);

  const [legs, setLegs] = useState<Load[] | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  // Customer profile modal — opened by the "View customer profile"
  // button inside the broker field. null = closed.
  const [customerProfileId, setCustomerProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false);
  const [reviewQueueOpen, setReviewQueueOpen] = useState(false);
  const [docsModalOpen, setDocsModalOpen] = useState(false);

  // Editable draft. Only fields the user has touched land here — we
  // overlay it on top of the canonical fetched load when rendering,
  // and turn it into a PATCH payload on save. Cleared after a
  // successful save / on Discard / when a different load loads.
  type LoadDraft = Partial<Pick<Load,
    'loadNum' | 'broker' | 'customerId' | 'dispatcher' |
    'trailerType' | 'trailerId' | 'trailerName' | 'trailerNum' |
    'commodity' | 'weight' |
    'loadPrice' | 'driverPay' |
    'notes' | 'specialInstructions' | 'internalNotes' |
    'accessorials' | 'refNums' | 'stops'>>;
  const [draft, setDraft] = useState<LoadDraft>({});
  // Partner-leg draft holds the per-leg fields the page can edit on the
  // partner load (right now just driverPay for the relay delivery leg).
  // We separate it from `draft` so handleSave knows to PATCH the partner
  // load row vs the primary one without diffing key sets.
  const [partnerDraft, setPartnerDraft] = useState<Partial<Pick<Load, 'driverPay'>>>({});
  const [saving, setSaving] = useState(false);
  // Name the dispatcher typed in the broker combobox that doesn't match
  // any existing customer. When set, NewBrokerReviewModal opens with
  // that name pre-filled; null = closed.
  const [pendingNewBroker, setPendingNewBroker] = useState<string | null>(null);

  function patchDraft(patch: LoadDraft) {
    setDraft(d => ({ ...d, ...patch }));
  }
  function discardDraft() {
    setDraft({});
    setPartnerDraft({});
  }
  function patchPartnerDraft(patch: Partial<Pick<Load, 'driverPay'>>) {
    setPartnerDraft(d => ({ ...d, ...patch }));
  }

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

  // Drop any pending edits whenever a fresh load lands so the form
  // resets to the persisted state. Without this, refresh-after-save
  // would visibly leave the user's input on top of the saved row.
  const primaryLoadId = primaryLeg?.loadId;
  const partnerLoadId = partnerLeg?.loadId;
  useEffect(() => { setDraft({}); setPartnerDraft({}); }, [primaryLoadId, partnerLoadId]);

  // Effective load = persisted row + any pending edits on top.
  const effective: Load | undefined = useMemo(
    () => primaryLeg ? { ...primaryLeg, ...draft } : undefined,
    [primaryLeg, draft],
  );
  const effectivePartner: Load | undefined = useMemo(
    () => partnerLeg ? { ...partnerLeg, ...partnerDraft } : undefined,
    [partnerLeg, partnerDraft],
  );
  const isDirty = Object.keys(draft).length > 0 || Object.keys(partnerDraft).length > 0;

  // Save flow. Routes load-level fields through PATCH /v1/loads/:id and
  // stops through replaceStops on the primary event. Stops live event-
  // side because each event owns its leg's route; we only patch them
  // when the user actually edited them, otherwise the API would
  // overwrite the canonical row with a stale copy on every save.
  async function handleSave() {
    if (!primaryLeg?.loadId || saving) return;
    setSaving(true);
    try {
      useCalendarStore.getState().markLoadSelfWrite(primaryLeg.loadId);
      if (partnerLeg?.loadId) {
        useCalendarStore.getState().markLoadSelfWrite(partnerLeg.loadId);
      }
      const { stops: nextStops, ...loadPatch } = draft;
      if (Object.keys(loadPatch).length > 0) {
        await railway.updateLoad(primaryLeg.loadId, loadPatch);
      }
      if (nextStops !== undefined) {
        await railway.replaceStops(primaryLeg.id, { stops: nextStops });
      }
      // Partner driver pay is the only partner-side field the page
      // currently edits. PATCH the partner's load row directly — the
      // other relay assignment fields (driver/asset/stops) stay
      // calendar-modal-only on this page.
      if (partnerLeg?.loadId && Object.keys(partnerDraft).length > 0) {
        // Cast: UpdateLoadRequest's driverPay is number|null whereas
        // Load.driverPay is number|undefined. Same shape on the wire,
        // just a narrower union — safe to widen back here.
        await railway.updateLoad(partnerLeg.loadId, partnerDraft as Parameters<typeof railway.updateLoad>[1]);
      }
      setDraft({});
      setPartnerDraft({});
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] save failed:', e);
      window.alert(`Save failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    } finally {
      setSaving(false);
    }
  }

  // Locked-field hint. Flashes a yellow callout at the top of the form
  // pane when a dispatcher clicks a non-editable field. Auto-dismisses
  // after a few seconds so it never blocks the page indefinitely.
  const [lockedHintAt, setLockedHintAt] = useState<number>(0);
  const lockedHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashLockedHint() {
    setLockedHintAt(Date.now());
    if (lockedHintTimerRef.current) clearTimeout(lockedHintTimerRef.current);
    lockedHintTimerRef.current = setTimeout(() => setLockedHintAt(0), 4000);
  }

  // Priority + billing status flip immediately via the closeout
  // endpoint — they aren't part of the Save draft like the financial
  // edits are. The endpoint covers both legs of a relay so we only need
  // the primary's load id.
  async function flipPriority() {
    if (!primaryLeg?.loadId) return;
    const next = !primaryLeg.priority;
    try {
      useCalendarStore.getState().markLoadSelfWrite(primaryLeg.loadId);
      await railway.updateLoadCloseout(primaryLeg.loadId, {
        action: next ? 'set_priority' : 'clear_priority',
        actorName: currentUserName,
      });
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] priority toggle failed:', e);
      window.alert(`Priority change failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    }
  }
  async function setEventStatus(next: LoadStatus) {
    if (!primaryLeg?.id) return;
    if ((primaryLeg.status ?? 'scheduled') === next) return;
    try {
      if (primaryLeg.loadId) {
        useCalendarStore.getState().markLoadSelfWrite(primaryLeg.loadId);
      }
      // events.status is the lifecycle source-of-truth. PATCH both legs
      // on a relay load so the chips and reports stay aligned — a relay
      // with one leg in en_route and the other still scheduled would
      // confuse downstream views.
      await railway.updateEvent(primaryLeg.id, { status: next });
      if (partnerLeg?.id) {
        await railway.updateEvent(partnerLeg.id, { status: next });
      }
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] status change failed:', e);
      window.alert(`Status change failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    }
  }

  // Invoice action state. Tracks which mutation is in flight so the
  // billing card can disable the affected button + show a spinner.
  // Generate, send, and resend are the three remote mutations; "view"
  // affordances stay synchronous (they just open a modal).
  const [invoiceBusy, setInvoiceBusy] = useState<null | 'generate' | 'send' | 'resend'>(null);

  async function handleGenerateInvoice() {
    if (!primaryLeg?.loadId || invoiceBusy) return;
    setInvoiceBusy('generate');
    try {
      // batchGenerateInvoices is the same path accounting takes — it
      // handles the "revive stale void" rescue and the customer-fk
      // fallback. We pass thenSend=false so the user can review the
      // draft before mailing it.
      if (invoice && invoice.status !== 'void') {
        // Existing invoice → regenerate refreshes the packet against
        // the current load shape (line items, included docs, broker).
        await railway.regenerateInvoice(invoice.id, {});
      } else {
        await railway.batchGenerateInvoices({
          loadIds: [primaryLeg.loadId],
          thenSend: false,
          bccSelf: true,
          attachLoadDocs: true,
        });
      }
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] generate invoice failed:', e);
      window.alert(`Invoice generation failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    } finally {
      setInvoiceBusy(null);
    }
  }

  async function handleSendOrResendInvoice() {
    if (!invoice || invoiceBusy) return;
    const resend = invoice.status === 'sent' || invoice.status === 'paid';
    setInvoiceBusy(resend ? 'resend' : 'send');
    try {
      const body = { invoiceIds: [invoice.id], bccSelf: true, attachLoadDocs: true };
      if (resend) await railway.batchResendInvoices(body);
      else        await railway.batchSendInvoices(body);
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] send invoice failed:', e);
      window.alert(`Invoice send failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    } finally {
      setInvoiceBusy(null);
    }
  }

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

  // Title pairs the system-assigned internal id with the broker-supplied
  // load number when there is one — that's the dispatcher's primary
  // search key in real conversations ("the 3096735 from XPO"), even
  // though the URL slug stays on internal id for stability.
  const internalIdLabel = primaryLeg.internalLoadId ?? internalLoadId;
  const brokerLoadNum = (primaryLeg.loadNum ?? '').trim();
  const headerTitle = brokerLoadNum
    ? `Load #${internalIdLabel} · ${brokerLoadNum}`
    : `Load #${internalIdLabel}`;
  const isRelay = !!partnerLeg;

  return (
    <AppShell title={headerTitle} icon={Truck}>
      <div className="flex flex-col px-6 pt-5 pb-6 gap-3">
        {/* Top toolbar. Save / Discard surface only when there are
            pending edits — same dirty-detection rhythm EventModal
            uses, just lifted to the page header instead of the modal
            footer. Stays sticky at the top of the scroll viewport so
            the leg + state controls and the Save / Discard buttons
            remain reachable as the page scrolls. */}
        <div className="sticky top-0 z-10 -mx-6 px-6 py-2 flex items-center gap-2 flex-wrap"
          style={{ background: 'var(--gc-bg)' }}>
          <button onClick={() => router.back()}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <ArrowLeft size={12} /> Back
          </button>
          {/* Calendar nav. For a solo load there's just one event so we
              show a single "View in Calendar" pill. For relays we surface
              both legs, since each owns its own driver/asset/stops and
              the dispatcher might want to jump to either. Buttons stash
              the target event-id in the calendar store (openEditModal)
              then route to "/" so the modal opens on first paint. */}
          {!isRelay && (
            <button
              onClick={() => {
                useCalendarStore.getState().openEditModal(primaryLeg.id);
                router.push('/');
              }}
              className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
              <CalendarIcon size={12} /> View in Calendar
            </button>
          )}
          {isRelay && (
            <>
              <button
                onClick={() => {
                  // Pickup leg = primary in our load model — that's the
                  // leg the URL slug lands on. Open it directly.
                  useCalendarStore.getState().openEditModal(primaryLeg.id);
                  router.push('/');
                }}
                className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
                style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#6d28d9' }}>
                <CalendarIcon size={12} /> View Pickup Leg
              </button>
              <button
                onClick={() => {
                  useCalendarStore.getState().openEditModal(partnerLeg!.id);
                  router.push('/');
                }}
                className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
                style={{ background: '#f5f3ff', border: '1px solid #ddd6fe', color: '#6d28d9' }}>
                <CalendarIcon size={12} /> View Delivery Leg
              </button>
            </>
          )}
          {/* Review opens the closeout review panel — same UI the
              calendar surfaces via the "Review" button in the load
              modal. Resolves to the pickup leg before launch so the
              meta + relay-partner lookup line up. */}
          <button
            type="button"
            onClick={() => setReviewQueueOpen(true)}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <ClipboardCheck size={12} /> Review
          </button>
          {/* Manage Documents opens the same docs-preview modal the
              accounting screen uses — left list of attached docs with
              per-doc include checkboxes, right viewer pane. */}
          <button
            type="button"
            onClick={() => setDocsModalOpen(true)}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <FolderOpen size={12} /> Manage Documents
          </button>
          {/* Locked-field click hint. Surfaces in-line with the toolbar
              so the prompt is always next to the View in Calendar pill
              the dispatcher needs to click next. Auto-dismisses after
              4 seconds via the flash timer. */}
          {lockedHintAt > 0 && (
            <div className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5"
              style={{ background: '#fef3c7', border: '1px solid #fcd34d', color: '#92400e' }}>
              <Lock size={11} />
              Edit this field in the calendar.
            </div>
          )}
          <div className="flex-1" />
          {isDirty && (
            <>
              <button onClick={discardDraft} disabled={saving}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors disabled:opacity-60"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
                Discard changes
              </button>
              <button onClick={() => void handleSave()} disabled={saving}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors disabled:opacity-60"
                style={{ background: LOAD_ACCENT, color: '#fff' }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : null}
                Save changes
              </button>
            </>
          )}
        </div>

        {/* Cards grow with their natural content now — the page itself
            scrolls instead of every container clamping to the viewport.
            That gives the route map and billing card the room they
            need to breathe (line items, doc badges, large maps) without
            cramming everything into a single screenful. The form pane
            still sets the left column's height via the grid-row span
            so the right column's two cards (map on top, billing below)
            share its total. */}
        <div className="grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)' }}>

          {/* Left — load fields, modal-styled */}
          <div className="rounded-xl flex flex-col overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            {/* ui-scale-scope: inherits Settings → Appearance → "Calendar
                card text" sizing, exactly like EventModal does. */}
            <div className="ui-scale-scope"
              style={{ ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1 } as React.CSSProperties}>
              <LoadFormPane
                primary={effective ?? primaryLeg}
                partner={effectivePartner ?? partnerLeg}
                customerById={customerById}
                assets={assets}
                drivers={drivers}
                customers={customers}
                sectionOrder={sectionOrder}
                fieldSettings={fieldSettings}
                driverPayPct={driverPayPct}
                onOpenCustomerProfile={setCustomerProfileId}
                onCreateBroker={setPendingNewBroker}
                onChangePartner={patchPartnerDraft}
                onClickLocked={flashLockedHint}
                onPriorityToggle={() => void flipPriority()}
                onStatusChange={(next) => void setEventStatus(next)}
                currentUserName={currentUserName}
                calendarTimezone={calendarTimezone}
                onChange={patchDraft}
              />
            </div>
          </div>

          {/* Top-right — route map. min-height gives the map room to
              render its tiles + the stops sidebar even when the form
              pane on the left is shorter than usual. */}
          <div className="rounded-xl flex flex-col overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', minHeight: 480 }}>
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

          {/* Bottom-right — billing. min-height keeps the customer +
              line items + actions section visible at first paint
              instead of collapsing to a tiny strip on tall form
              panes. */}
          <div className="rounded-xl flex flex-col overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', minHeight: 360 }}>
            <BillingCard
              load={primaryLeg}
              onOpenReview={() => setReviewQueueOpen(true)}
              onOpenCustomerProfile={setCustomerProfileId}
              customer={(() => {
                // Customer details for the billing pane. Prefer the FK
                // bound on the load row; fall back to a case-insensitive
                // broker-text + alias match so legacy loads still
                // surface invoiceMethod / email / portal info.
                if (primaryLeg.customerId) {
                  return customers.find(c => c.id === primaryLeg.customerId);
                }
                const t = (primaryLeg.broker ?? '').trim().toLowerCase();
                if (!t) return undefined;
                return customers.find(c =>
                  c.name.toLowerCase() === t
                  || (c.aliases ?? []).some(a => a.toLowerCase() === t),
                );
              })()}
              invoice={invoice}
              busy={invoiceBusy}
              onGenerate={() => void handleGenerateInvoice()}
              onSendOrResend={() => void handleSendOrResendInvoice()}
              onViewInvoice={() => setInvoiceModalOpen(true)}
              onViewDocs={() => setDocsModalOpen(true)}
            />
          </div>
        </div>
      </div>

      {invoiceModalOpen && invoice && (
        <InvoiceDetailModal invoiceId={invoice.id}
          onClose={() => setInvoiceModalOpen(false)} />
      )}
      {customerProfileId && (
        <BrokerProfileModal
          initialBrokerId={customerProfileId}
          onClose={() => setCustomerProfileId(null)} />
      )}
      {/* Closeout review panel. Mounts for either "Review" or "Manage
          Documents" — when the dispatcher clicked Manage Documents we
          autoOpenManageDocs so the DocSelectionDialog pops on mount
          and they land inside the doc manager directly; the review
          chrome stays underneath in case they close the dialog. */}
      {(reviewQueueOpen || docsModalOpen) && (
        <ReviewQueue
          loads={[primaryLeg]}
          zIndex={250}
          autoOpenManageDocs={docsModalOpen}
          onClose={() => {
            setReviewQueueOpen(false);
            setDocsModalOpen(false);
          }}
          onLoadResolved={async () => {
            await refresh({ silent: true });
            bumpLoadEditTick();
          }}
        />
      )}
      {/* NewBrokerReviewModal — appears when the CustomerCombobox
          "Add &lt;name&gt;" affordance fires for a name that doesn't
          match any existing customer. On confirm we create the row,
          stash both broker text + customerId into the draft so the
          FK and the display name save atomically, and re-open the
          combobox in linked-state on the next render. */}
      {pendingNewBroker !== null && (
        <NewBrokerReviewModal
          initialName={pendingNewBroker}
          accentColor={LOAD_ACCENT}
          onCancel={() => setPendingNewBroker(null)}
          onConfirm={async (payload) => {
            const created = await addCustomer(payload);
            if (created) {
              patchDraft({ broker: created.name, customerId: created.id });
            }
            setPendingNewBroker(null);
          }}
        />
      )}
    </AppShell>
  );
}

// ─── Left card — modal-styled form ──────────────────────────────────────

function LoadFormPane({
  primary, partner, customerById, assets, drivers, customers,
  sectionOrder, fieldSettings,
  driverPayPct, onOpenCustomerProfile, onCreateBroker, onChangePartner,
  onClickLocked, onPriorityToggle, onStatusChange,
  currentUserName, calendarTimezone, onChange,
}: {
  primary: Load;
  partner: Load | undefined;
  customerById: Map<string, { id: string; name: string }>;
  assets: { id: number; name?: string | null; unit?: string | null }[];
  drivers: { id?: number; name?: string; firstName?: string; lastName?: string; phone?: string }[];
  customers: Customer[];
  sectionOrder: FieldSection[];
  fieldSettings: Record<string, boolean>;
  /** Org default driver-pay percentage from settings.rateConSettings.
   *  Powers the "%" badge next to Driver Pay + the "Reset to default"
   *  affordance when the manual value diverges. null disables both. */
  driverPayPct: number | null;
  onOpenCustomerProfile: (customerId: string) => void;
  /** Fires when the CustomerCombobox user clicks "Add &lt;name&gt;".
   *  Parent opens NewBrokerReviewModal with the prefilled name. */
  onCreateBroker: (name: string) => void;
  /** Patch into the PARTNER leg's draft — currently used for the relay
   *  delivery driver pay. Only meaningful when `partner` is set. */
  onChangePartner: (patch: Partial<Pick<Load, 'driverPay'>>) => void;
  /** Click on a locked (calendar-only) field. Parent flashes a top-of-
   *  page banner pointing the dispatcher at the View in Calendar pill. */
  onClickLocked: () => void;
  /** Flip primary.priority. Persists immediately via the closeout
   *  endpoint, which covers both legs of a relay. */
  onPriorityToggle: () => void;
  /** Change the load's lifecycle status. PATCHes events.status (both
   *  legs on a relay) and refreshes the page. */
  onStatusChange: (next: LoadStatus) => void;
  currentUserName: string;
  calendarTimezone: string;
  /** Patch into the draft. Each call merges into the page-level draft;
   *  the page diffs against the persisted load + builds the save
   *  payload. Pass `{ broker: 'X' }` to set, `{ broker: null }` to clear. */
  onChange: (patch: Partial<Load>) => void;
}) {
  const iStyle = inputStyle();
  const focusH = focusColor(LOAD_ACCENT);

  // ── Finalized-pay gating ────────────────────────────────────────────
  // If the driver's payroll for the load's week has been finalized,
  // we lock the per-leg driverPay input so an edit can't drift from
  // what was actually paid out. The banner under the input shows the
  // locked amount. Per-leg on relays because each leg has its own
  // driver and may be independently finalized.
  const primaryFinalized = useLoadPayFinalized(primary.driverName, primary.start);
  const partnerFinalized = useLoadPayFinalized(partner?.driverName, partner?.start);
  const isPrimaryFinalized = primaryFinalized.finalized;
  const isPartnerFinalized = partnerFinalized.finalized;

  // ── Derived values ──────────────────────────────────────────────────
  // Linked customer — first try the FK (canonical source). If the load
  // pre-dates customerId being written, fall back to a case-insensitive
  // name match so we still surface the linked badge + profile link for
  // those legacy loads. EventModal does the same for the profile popup.
  const linkedCustomerByFk = primary.customerId
    ? customerById.get(primary.customerId)
    : undefined;
  const brokerTextLc = (primary.broker ?? '').trim().toLowerCase();
  const linkedCustomerByName = !linkedCustomerByFk && brokerTextLc
    ? customers.find(c =>
        c.name.toLowerCase() === brokerTextLc
        || (c.aliases ?? []).some(a => a.toLowerCase() === brokerTextLc),
      )
    : undefined;
  const linkedCustomer = linkedCustomerByFk ?? linkedCustomerByName;
  // True when the badge is keyed off broker text rather than the FK.
  // We render the green "Linked to" pill either way, but use a different
  // affordance in copy so dispatch knows the FK isn't bound yet.
  const linkedByNameOnly = !linkedCustomerByFk && !!linkedCustomerByName;
  const brokerDisplay = displayBrokerName(
    linkedCustomer?.name ?? primary.broker ?? '',
    customers as Parameters<typeof displayBrokerName>[1],
  );

  const assetById = new Map(assets.map(a => [a.id, a]));
  const truckLabel = (a?: { name?: string | null; unit?: string | null }) =>
    a ? `${a.name ?? ''}${a.unit ? ` #${a.unit}` : ''}`.trim() : '';

  // Driver lookup so we can surface the driver phone underneath the
  // driver select — same affordance EventModal shows.
  const findDriver = (name: string | undefined) => {
    if (!name) return undefined;
    const n = name.trim().toLowerCase();
    return drivers.find(d => {
      const full = (d.name ?? `${d.firstName ?? ''} ${d.lastName ?? ''}`.trim()).toLowerCase();
      return full === n;
    });
  };
  const primaryDriver = findDriver(primary.driverName);

  // Pull the EXACT field-value for a given EventModal field id from
  // the load row. Mirrors how EventModal hydrates fieldValues from
  // the event, except sourced from loads.* instead of events.*.
  // Returns a string (or empty string) for rendering inside an
  // <input>. Special-case fields (refNums, accessorials) render their
  // own UI outside the generic field loop.
  // Pull the editable raw value for a given field id. Numbers come
  // through as plain strings so the caret behaves; commitField parses
  // back on write. Trailer (event-level) stays read-only here.
  function fieldValue(id: string): string {
    switch (id) {
      case 'loadNum':     return primary.loadNum ?? '';
      case 'broker':      return primary.broker ?? '';
      case 'dispatcher':  return primary.dispatcher ?? '';
      case 'trailerType': return primary.trailerType ?? '';
      case 'trailer':     return primary.trailerName ?? primary.trailerNum ?? '';
      case 'commodity':   return primary.commodity ?? '';
      case 'weight':      return primary.weight != null ? String(primary.weight) : '';
      case 'loadPrice':   return primary.loadPrice != null ? String(primary.loadPrice) : '';
      case 'driverPay':   return primary.driverPay != null ? String(primary.driverPay) : '';
      case 'notes':       return primary.notes ?? '';
      case 'specialInstructions': return primary.specialInstructions ?? '';
      default:            return '';
    }
  }

  // Commit a single field. Empty string clears (null on the wire);
  // numbers parse from the typed string and silently ignore garbage.
  function commitField(id: string, raw: string) {
    const isNumber = id === 'weight' || id === 'loadPrice' || id === 'driverPay';
    if (isNumber) {
      const trimmed = raw.trim();
      const parsed = trimmed === '' ? null : Number(trimmed);
      if (trimmed !== '' && (parsed == null || isNaN(parsed))) return;
      onChange({ [id]: parsed } as Partial<Load>);
      return;
    }
    onChange({ [id]: raw === '' ? null : raw } as Partial<Load>);
  }

  // ── Driver Pay percentage UX ────────────────────────────────────────
  // Same affordance EventModal shows: a small chip next to the Driver
  // Pay label rendering the live (driverPay / loadPrice) percentage,
  // plus a "Reset to default" button when the manual value diverges
  // from the org default. Persisted on Save like any other field.
  const driverPayPctValue = (() => {
    const lp = typeof primary.loadPrice === 'number' ? primary.loadPrice : 0;
    const dp = typeof primary.driverPay === 'number' ? primary.driverPay : 0;
    if (lp <= 0 || dp <= 0) return null;
    return Math.round((dp / lp) * 1000) / 10;
  })();
  const driverPayIsAuto = driverPayPct != null && driverPayPctValue != null
    && Math.abs(driverPayPctValue - driverPayPct) < 0.05;
  function resetDriverPay() {
    const lp = typeof primary.loadPrice === 'number' ? primary.loadPrice : 0;
    if (driverPayPct == null || lp <= 0) return;
    const auto = Math.round(lp * (driverPayPct / 100) * 100) / 100;
    onChange({ driverPay: auto });
  }
  const driverPayLabelSuffix = driverPayPctValue !== null ? (
    <span className="flex items-center gap-1 normal-case tracking-normal font-semibold" style={{ fontSize: 10 }}>
      <span className="px-1.5 py-0.5 rounded-lg"
        style={{
          background: driverPayIsAuto ? '#dbeafe' : '#f1f3f4',
          color:      driverPayIsAuto ? '#1d4ed8' : 'var(--gc-text-3)',
          border:     `1px solid ${driverPayIsAuto ? '#bfdbfe' : 'var(--gc-border-light)'}`,
        }}>
        {driverPayPctValue % 1 === 0 ? driverPayPctValue.toFixed(0) : driverPayPctValue.toFixed(1)}%
      </span>
      {!driverPayIsAuto && driverPayPct != null && (
        <button type="button" onClick={resetDriverPay}
          title={`Reset to ${driverPayPct}%`}
          className="flex items-center gap-1 rounded transition-colors"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--gc-text-3)', padding: '1px 4px' }}
          onMouseEnter={e => { e.currentTarget.style.color = '#1d4ed8'; e.currentTarget.style.background = '#dbeafe'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--gc-text-3)'; e.currentTarget.style.background = 'transparent'; }}>
          <RotateCcw size={10} />
          <span style={{ fontSize: 10 }}>Reset to {driverPayPct}%</span>
        </button>
      )}
    </span>
  ) : null;

  // Editable allowlist. Only these fields stay interactive on this
  // page — everything else is calendar-modal-only. Stops + accessorials
  // + internal notes are handled outside renderField but follow the
  // same rule.
  const EDITABLE_FIELD_IDS = new Set<string>(['broker', 'loadPrice', 'driverPay']);

  // Style locked inputs as muted + not-allowed so dispatchers can tell
  // at a glance which fields require the calendar to edit.
  const lockedStyle: React.CSSProperties = {
    ...iStyle,
    background: 'var(--gc-bg)',
    color: 'var(--gc-text-2)',
    cursor: 'not-allowed',
  };

  // Render one field row by id. Broker, refNums, and textareas get
  // dedicated treatments; everything else is a single text/number
  // input wired through commitField.
  function renderField(field: FieldDef) {
    const isEditable = EDITABLE_FIELD_IDS.has(field.id);

    // Load # — locked. Keep the inline CopyBtnInline working so
    // dispatchers can still grab the number for broker portals.
    if (field.id === 'loadNum') {
      const v = fieldValue('loadNum');
      return (
        <Field
          label={field.label}
          labelSuffix={<CopyBtnInline value={v} title="Copy load number" />}>
          <input type="text" value={v}
            placeholder={field.placeholder}
            readOnly
            onMouseDown={onClickLocked}
            style={lockedStyle} />
        </Field>
      );
    }
    // Trailer — locked StyledSelect-like display. We render the current
    // trailer name as a disabled "input" so the user sees the same
    // shape but clicks fire the lock hint.
    if (field.id === 'trailer') {
      const current = primary.trailerName ?? primary.trailerNum ?? '';
      return (
        <Field label={field.label}>
          <input type="text" value={current}
            placeholder="—"
            readOnly
            onMouseDown={onClickLocked}
            style={lockedStyle} />
        </Field>
      );
    }
    // Driver Pay — for solo loads, a generic number input with the
    // percentage chip + reset button via labelSuffix.
    // For relay loads, swap the slot for a read-only "Total Driver Pay"
    // tile (Pickup + Delivery summed). The editable Pickup/Delivery
    // inputs appear below the section's fields (see renderSection
    // 'financial' tail) — same pattern EventModal uses.
    if (field.id === 'driverPay') {
      if (partner) {
        const pickupNum = typeof primary.driverPay === 'number' ? primary.driverPay : 0;
        const deliveryNum = typeof partner.driverPay === 'number' ? partner.driverPay : 0;
        const total = pickupNum + deliveryNum;
        const lp = typeof primary.loadPrice === 'number' ? primary.loadPrice : 0;
        const totalPct = lp > 0 && total > 0
          ? Math.round((total / lp) * 1000) / 10
          : null;
        const totalSuffix = totalPct !== null ? (
          <span className="px-1.5 py-0.5 rounded-lg normal-case tracking-normal font-semibold"
            style={{ fontSize: 10, background: '#f1f3f4', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
            {totalPct % 1 === 0 ? totalPct.toFixed(0) : totalPct.toFixed(1)}%
          </span>
        ) : null;
        return (
          <Field label="Total Driver Pay" labelSuffix={totalSuffix}>
            <div className="flex items-center w-full rounded-lg text-sm"
              style={{ border: '1px solid var(--gc-border)', padding: '8px 10px', background: 'var(--gc-bg)', color: 'var(--gc-text-1)', minHeight: 38 }}>
              {total > 0
                ? `$${total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
            </div>
          </Field>
        );
      }
      return (
        <Field label={field.label} labelSuffix={driverPayLabelSuffix}>
          <input type="number" value={fieldValue('driverPay')}
            placeholder={field.placeholder}
            onChange={e => commitField('driverPay', e.target.value)}
            disabled={isPrimaryFinalized}
            title={isPrimaryFinalized
              ? 'Locked — driver pay has been finalized for this week. Reopen the payroll record on the Payroll page to edit.'
              : undefined}
            style={{
              ...iStyle,
              fontVariantNumeric: 'tabular-nums',
              ...(isPrimaryFinalized ? { background: '#f1f5f9', color: 'var(--gc-text-3)', cursor: 'not-allowed' } : null),
            }}
            onFocus={focusH} onBlur={blurColor} />
          {/* Finalized banner — visible only when payroll for the
              load's (driver, week) has already been recorded. The
              input above is also disabled so the amount stays
              honest. */}
          <div className="mt-2">
            <FinalizedPayBanner
              driverName={primary.driverName}
              pickupIso={primary.start}
              driverPay={primary.driverPay}
            />
          </div>
        </Field>
      );
    }
    // Broker — editable input + the green "Linked to" tag and "View
    // customer profile" button when the FK is set. Editing the text
    // doesn't break the FK link (separate columns).
    if (field.id === 'broker') {
      return (
        <Field label={field.label}>
          <div className="space-y-2">
            <CustomerCombobox
              value={fieldValue('broker')}
              customers={customers}
              accentColor={LOAD_ACCENT}
              // Free-typing — sync the text but DON'T touch customerId.
              // The "Matches X" pill below uses name fallback, but the
              // FK only flips when the user picks from the dropdown or
              // creates a new customer.
              onChange={(val) => onChange({ broker: val === '' ? null : val } as Partial<Load>)}
              onPick={(c) => onChange({ broker: c.name, customerId: c.id })}
              onCreateNew={(name) => { onCreateBroker(name); }}
            />
            {linkedCustomer && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
                  style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: '#15803d' }}>
                    {linkedByNameOnly ? 'Matches' : 'Linked to'}{' '}
                    <strong>{linkedCustomer.name}</strong>
                  </span>
                </div>
                <button type="button"
                  onClick={() => onOpenCustomerProfile(linkedCustomer.id)}
                  className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: LOAD_ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
                  <ExternalLinkIcon size={12} /> View customer profile
                </button>
              </>
            )}
          </div>
        </Field>
      );
    }
    // Ref numbers — display the shared chip-badge widget but keep ONLY
    // the inline Copy buttons functional. Edits (× remove, Add row,
    // typing) bounce the dispatcher to the calendar. We do this with a
    // click-capture handler that walks up to the nearest button and
    // checks its title — RefNumsField's copy buttons have `title="Copy"`
    // so we let those clicks through while every other interaction
    // fires the lock hint.
    if (field.id === 'refNums') {
      const refs = primary.refNums ?? [];
      return (
        <Field label={field.label}>
          <div
            onClickCapture={(e) => {
              const target = e.target as HTMLElement | null;
              const btn = target?.closest('button');
              const isCopyBtn = btn?.getAttribute('title') === 'Copy';
              if (isCopyBtn) return; // let the Copy button do its work
              // Anything else — including the inputs in the Add row,
              // the × confirm-remove, and the preset chips — is locked.
              e.preventDefault();
              e.stopPropagation();
              onClickLocked();
            }}
            style={{ cursor: 'not-allowed' }}>
            <RefNumsField
              value={refs}
              onChange={() => { /* locked — onChange is gated by the
                                  click-capture above */ }}
              headerColor={LOAD_ACCENT}
              chipBg={LOAD_ACCENT_BG}
              chipBorder={LOAD_ACCENT_BORDER}
            />
          </div>
        </Field>
      );
    }
    if (field.type === 'textarea') {
      return (
        <Field label={field.label}>
          <textarea value={fieldValue(field.id)}
            placeholder={field.placeholder}
            rows={3}
            readOnly
            onMouseDown={onClickLocked}
            style={{ ...lockedStyle, resize: 'none', fontFamily: 'inherit', minHeight: 72 }} />
        </Field>
      );
    }
    // Generic text/number input. loadPrice is the only one that stays
    // editable; everything else (commodity, weight, trailerType,
    // dispatcher, etc.) is locked.
    const isNumber = field.type === 'number';
    if (isEditable) {
      return (
        <Field label={field.label}>
          <input type={isNumber ? 'number' : 'text'} value={fieldValue(field.id)}
            placeholder={field.placeholder}
            onChange={e => commitField(field.id, e.target.value)}
            style={{ ...iStyle, fontVariantNumeric: isNumber ? 'tabular-nums' : undefined }}
            onFocus={focusH} onBlur={blurColor} />
        </Field>
      );
    }
    return (
      <Field label={field.label}>
        <input type={isNumber ? 'number' : 'text'} value={fieldValue(field.id)}
          placeholder={field.placeholder}
          readOnly
          onMouseDown={onClickLocked}
          style={{ ...lockedStyle, fontVariantNumeric: isNumber ? 'tabular-nums' : undefined }} />
      </Field>
    );
  }

  // Pair adjacent fields into two-column rows the same way the modal
  // does: every two fields share a `grid grid-cols-2 gap-4`. Fields
  // flagged `span` OR textareas (Special Instructions et al.) take a
  // full-width row and skip pairing — matching EventModal's layout
  // where the long-form textarea spans the container.
  function renderSectionFields(fields: FieldDef[]) {
    const isFull = (f: FieldDef) => f.span || f.type === 'textarea';
    const rows: FieldDef[][] = [];
    let bucket: FieldDef[] = [];
    for (const f of fields) {
      if (isFull(f)) {
        if (bucket.length) { rows.push(bucket); bucket = []; }
        rows.push([f]);
        continue;
      }
      bucket.push(f);
      if (bucket.length === 2) { rows.push(bucket); bucket = []; }
    }
    if (bucket.length) rows.push(bucket);
    return (
      <div className="space-y-4">
        {rows.map((row, i) => {
          // Full-width rows render without the 2-col grid so the
          // textarea actually spans the container instead of sitting
          // in the left column with a phantom right gutter.
          if (row.length === 1 && isFull(row[0])) {
            return <div key={i}>{renderField(row[0])}</div>;
          }
          return (
            <div key={i} className="grid grid-cols-2 gap-4">
              {row.map(f => <div key={f.id}>{renderField(f)}</div>)}
              {row.length === 1 && <div />}
            </div>
          );
        })}
      </div>
    );
  }

  // The 'locations' section mounts the real StopsSection from the
  // calendar modal so the load page renders the IDENTICAL widget:
  // header with loaded-mi + $/mi + Map Route badges, drag-handled
  // stop cards with the type select, time-zone label, facility +
  // address inputs with the geocode check, the Appt / Window / FCFS
  // pill set, and the date + time pickers. The surrounding
  // <fieldset disabled> on the page blocks edits — the interactive
  // controls render the same, they just don't fire.
  function renderSection(section: FieldSection, first: boolean) {
    if (section === 'locations') {
      const loadedMiles = primary.loadedMiles ?? null;
      const rpm = loadedMiles && loadedMiles > 0 && primary.loadPrice != null
        ? primary.loadPrice / loadedMiles
        : null;
      return (
        <div key={section}
          style={first ? {} : { borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
          {/* Relay block sits directly above the locations section so
              the dispatcher reads "pickup leg → relay handoff →
              delivery leg" in physical order. Purple-on-lavender to
              match the calendar's relay color. Fields are read-only
              because the relay pair is driven by both legs' events;
              editing here would split the source of truth — the inline
              note points dispatch back to the calendar instead. */}
          {partner && (
            <div className="mb-5 p-4 rounded-xl"
              style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: '#6d28d9' }}>
                  Relay — Delivery Leg
                </div>
                <div className="flex items-center gap-1.5 text-[11px]"
                  style={{ color: '#6d28d9' }}>
                  <Info size={11} />
                  Edit relay legs in the calendar
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Delivery Driver">
                  <input type="text" value={partner.driverName ?? ''} readOnly
                    placeholder="Unassigned"
                    onMouseDown={onClickLocked}
                    style={{ ...lockedStyle, borderColor: '#ddd6fe' }} />
                </Field>
                <Field label="Delivery Truck">
                  <input type="text" value={truckLabel(assetById.get(partner.assetId))} readOnly
                    placeholder="—"
                    onMouseDown={onClickLocked}
                    style={{ ...lockedStyle, borderColor: '#ddd6fe' }} />
                </Field>
              </div>
            </div>
          )}
          {/* StopsSection is locked — the calendar modal owns route
              editing because each leg's stops live on its own event.
              We still render the full widget so dispatch can read
              everything (facility names, appt windows, geocode), but
              any click bounces them to the calendar via the hint. */}
          <div style={{ position: 'relative' }}>
            <div style={{ pointerEvents: 'none', opacity: 0.92 }}>
              <StopsSection
                stops={primary.stops}
                onChange={() => { /* locked */ }}
                headerColor={LOAD_ACCENT}
                loadedMiles={loadedMiles}
                loadPrice={primary.loadPrice ?? null}
                ratePerMile={rpm}
              />
            </div>
            <div
              onClick={onClickLocked}
              style={{ position: 'absolute', inset: 0, cursor: 'not-allowed' }} />
          </div>
        </div>
      );
    }

    // Generic load/financial/notes section.
    const fields = getEnabledFieldsForSection(section, fieldSettings);
    if (fields.length === 0 && section !== 'financial') return null;

    return (
      <ModalSection key={section} title={SECTION_LABELS[section]} first={first}>
        {renderSectionFields(fields)}

        {/* Relay-only: Pickup + Delivery Driver Pay inputs. Sit right
            below the (now read-only) Total Driver Pay tile so the
            two halves and the sum stay visually grouped. Pickup goes
            to primary.driverPay (the same column solo loads write).
            Delivery routes through onChangePartner since it lives on
            the partner load row. */}
        {section === 'financial' && partner && (() => {
          const lp = typeof primary.loadPrice === 'number' ? primary.loadPrice : 0;
          const pctOf = (n: number) => (lp > 0 && n > 0 ? Math.round((n / lp) * 1000) / 10 : null);
          const pickupNum = typeof primary.driverPay === 'number' ? primary.driverPay : 0;
          const deliveryNum = typeof partner.driverPay === 'number' ? partner.driverPay : 0;
          const fmtPct = (p: number) => `${p % 1 === 0 ? p.toFixed(0) : p.toFixed(1)}%`;
          const pctChip = (p: number | null) => p === null ? null : (
            <span className="px-1.5 py-0.5 rounded-lg normal-case tracking-normal font-semibold"
              style={{ fontSize: 10, background: '#f1f3f4', color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}>
              {fmtPct(p)}
            </span>
          );
          const finalizedHint = 'Locked — driver pay has been finalized for this week. Reopen the payroll record on the Payroll page to edit.';
          return (
            <div className="mt-4 grid grid-cols-2 gap-4">
              <Field label="Pickup Driver Pay" labelSuffix={pctChip(pctOf(pickupNum))}>
                <input type="number" value={pickupNum === 0 ? '' : pickupNum}
                  placeholder="0.00"
                  onChange={e => {
                    const raw = e.target.value.trim();
                    const parsed = raw === '' ? null : Number(raw);
                    if (raw !== '' && (parsed == null || isNaN(parsed))) return;
                    onChange({ driverPay: parsed } as Partial<Load>);
                  }}
                  disabled={isPrimaryFinalized}
                  title={isPrimaryFinalized ? finalizedHint : undefined}
                  style={{
                    ...iStyle,
                    fontVariantNumeric: 'tabular-nums',
                    ...(isPrimaryFinalized ? { background: '#f1f5f9', color: 'var(--gc-text-3)', cursor: 'not-allowed' } : null),
                  }}
                  onFocus={focusH} onBlur={blurColor} />
                <div className="mt-2">
                  <FinalizedPayBanner
                    driverName={primary.driverName}
                    pickupIso={primary.start}
                    driverPay={primary.driverPay}
                  />
                </div>
              </Field>
              <Field label="Delivery Driver Pay" labelSuffix={pctChip(pctOf(deliveryNum))}>
                <input type="number" value={deliveryNum === 0 ? '' : deliveryNum}
                  placeholder="0.00"
                  onChange={e => {
                    const raw = e.target.value.trim();
                    const parsed = raw === '' ? null : Number(raw);
                    if (raw !== '' && (parsed == null || isNaN(parsed))) return;
                    // null is the "clear" sentinel; cast through unknown
                    // to satisfy Load.driverPay's number|undefined sig.
                    // The converter (loads.ts) coerces null → DB NULL.
                    onChangePartner({ driverPay: parsed as unknown as number });
                  }}
                  disabled={isPartnerFinalized}
                  title={isPartnerFinalized ? finalizedHint : undefined}
                  style={{
                    ...iStyle,
                    fontVariantNumeric: 'tabular-nums',
                    ...(isPartnerFinalized ? { background: '#f1f5f9', color: 'var(--gc-text-3)', cursor: 'not-allowed' } : null),
                  }}
                  onFocus={focusH} onBlur={blurColor} />
                <div className="mt-2">
                  <FinalizedPayBanner
                    driverName={partner.driverName}
                    pickupIso={partner.start}
                    driverPay={partner.driverPay}
                  />
                </div>
              </Field>
            </div>
          );
        })()}

        {/* Accessorials editor — same data model as the modal:
            category select, description, amount, billable toggle,
            and the per-row Pay Driver flip that routes the amount
            into payroll. Empty list renders just the + button. */}
        {section === 'financial' && (
          <div className="mt-4">
            <AccessorialsEditor
              value={primary.accessorials ?? []}
              onChange={(next) => onChange({ accessorials: next })}
              iStyle={iStyle}
              payOpts={(() => {
                // Drivers eligible for an accessorial payroll line.
                // Primary leg's driver first; relay partner's second
                // (deduped). Empty list when neither leg has a driver —
                // the toggle still works, the dropdown just hides.
                const opts: string[] = [];
                if (primary.driverName) opts.push(primary.driverName);
                if (partner?.driverName && !opts.includes(partner.driverName)) {
                  opts.push(partner.driverName);
                }
                return opts;
              })()}
            />
            {primary.totalBillable != null && primary.totalBillable !== primary.loadPrice && (
              <div className="mt-2 text-right text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                Total billable{' '}
                <strong className="tabular-nums" style={{ color: 'var(--gc-text-1)' }}>
                  {moneyFmt.format(primary.totalBillable)}
                </strong>
              </div>
            )}
          </div>
        )}
      </ModalSection>
    );
  }

  // Order sections per ALL_FIELDS' DEFAULT_SECTION_ORDER (settings
  // override applies). Always ensure 'locations' renders even when
  // missing from the saved order — the stops list is too important
  // to drop just because a config skipped it.
  const finalOrder = sectionOrder.includes('locations')
    ? sectionOrder
    : [...sectionOrder, 'locations' as FieldSection];

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="px-8 py-6 space-y-5">

      {/* Title row — identical look to EventModal's title input.
          Source is load.title (the event title — both relay legs share
          the same one). The bottom border uses LOAD_ACCENT.

          Priority star + lifecycle Status select live in the right
          slot of this row so they read as load metadata, not page
          controls. Both flip immediately via their respective
          endpoints (no Save draft) since they're single-click
          actions, not field edits. */}
      <div
        className="w-full flex items-center gap-2"
        style={{ borderBottom: `2px solid ${LOAD_ACCENT}`, paddingBottom: 8 }}>
        <input
          type="text"
          value={primary.title ?? ''}
          readOnly
          placeholder="No title"
          onMouseDown={onClickLocked}
          className="flex-1 bg-transparent outline-none font-medium"
          style={{
            fontSize: 22,
            color: 'var(--gc-text-1)',
            cursor: 'not-allowed',
          }}
        />
        <button
          type="button"
          onClick={onPriorityToggle}
          title={primary.priority ? 'Clear priority' : 'Mark priority'}
          className="px-2 py-1.5 rounded-lg inline-flex items-center transition-colors flex-shrink-0"
          style={{
            background: primary.priority ? '#fef3c7' : 'var(--gc-surface)',
            border: `1px solid ${primary.priority ? '#fcd34d' : 'var(--gc-border)'}`,
            color: primary.priority ? '#b45309' : 'var(--gc-text-3)',
          }}>
          <Star size={14}
            style={{ fill: primary.priority ? '#f59e0b' : 'none' }} />
        </button>
        <TitleStatusSelect
          value={primary.status ?? 'scheduled'}
          onChange={onStatusChange}
        />
      </div>

      {/* ── Assignment (always rendered first, above the user-ordered
          sections — matches EventModal's pinning of driver/asset above
          the load info). On relay loads the labels switch to "Pickup
          Driver / Pickup Truck" so the relay block below can carry the
          delivery pair without ambiguity. */}
      <ModalSection title="Assignment" first>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Field label={partner ? 'Pickup Driver' : 'Driver'}>
              {/* Locked — driver assignment is event-level. Mouse-down
                  flashes the calendar hint; the select itself is
                  pointer-events: none via the wrapper so the click
                  always reaches the parent. */}
              <input type="text"
                value={primary.driverName ?? ''}
                placeholder="— Unassigned —"
                readOnly
                onMouseDown={onClickLocked}
                style={lockedStyle} />
            </Field>
            {primaryDriver?.phone && (
              <DriverPhoneCopy phone={primaryDriver.phone} />
            )}
          </div>
          <Field label={partner ? 'Pickup Truck' : 'Truck'}>
            <input type="text"
              value={truckLabel(assetById.get(primary.assetId))}
              placeholder="— Unassigned —"
              readOnly
              onMouseDown={onClickLocked}
              style={lockedStyle} />
          </Field>
        </div>

        {/* Internal notes — yellow pinned thread tied to the load.
            Same look + state machine as EventModal: when there are no
            notes and no composer, show the dashed amber "+ Internal
            Note" button. Click → composer slides into a yellow card.
            Posted notes get pinned with author + timestamp; the × on
            each removes the note. Persisted via the draft payload on
            Save like any other load-level field. */}
        <div className="mt-4">
          <InternalNotesComposer
            value={primary.internalNotes ?? []}
            onChange={(next) => onChange({ internalNotes: next })}
            authorName={currentUserName}
          />
        </div>
      </ModalSection>

      {/* Sections in user-defined order from Settings → Appearance →
          Calendar form fields. Same source-of-truth EventModal uses,
          so reordering one reorders the other. Assignment is pinned
          above (already rendered with first=true), so none of these
          take the `first` flag — they all draw the upper divider. */}
      {finalOrder.map(section => renderSection(section, false))}

      {/* Check Calls — mirrors the modal placement (below the user-
          defined sections). Wraps the exact CheckCallsSection
          component the modal uses, so the styling, log button, and
          channel list match 1:1. */}
      {primary.loadId && (
        <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 20 }}>
          <CheckCallsSection
            loadId={primary.loadId}
            currentUserName={currentUserName}
            accentColor={LOAD_ACCENT}
          />
        </div>
      )}

      {/* Load history — created-by line + audit log. Mirrors the
          modal's footer history block. Compact: "Created by ..." and
          an expandable "View full history (N)" link. */}
      <LoadHistorySection load={primary} calendarTimezone={calendarTimezone} />
    </div>
  );
}

// ─── Accessorials editor ────────────────────────────────────────────────
//
// Same data model EventModal uses: id (uuid), category (one of the
// 6 enum values), description, amount, billable flag. "+ Accessorial"
// appends a new $0 detention row that the user fills in. Remove via
// the × button on each row.

const ACCESSORIAL_CATEGORIES = [
  { value: 'detention',    label: 'Detention' },
  { value: 'lumper',       label: 'Lumper' },
  { value: 'layover',      label: 'Layover' },
  { value: 'scale_ticket', label: 'Scale ticket' },
  { value: 'extra_stop',   label: 'Extra stop' },
  { value: 'other',        label: 'Other' },
] as const;

function AccessorialsEditor({
  value, onChange, iStyle, payOpts,
}: {
  value: import('@fleetcal/types').Accessorial[];
  onChange: (next: import('@fleetcal/types').Accessorial[]) => void;
  iStyle: React.CSSProperties;
  /** Drivers eligible to receive a per-accessorial payroll line. For
   *  non-relay loads this is just the load's assigned driver; for relays
   *  it includes both legs' drivers. Empty list hides the dropdown
   *  (toggle still shows so dispatch can flip the flag pre-assignment). */
  payOpts: string[];
}) {
  const focusH = focusColor('#16a34a');
  const ACC_COLOR = '#16a34a';

  function update(idx: number, patch: Partial<import('@fleetcal/types').Accessorial>) {
    onChange(value.map((a, i) => i === idx ? { ...a, ...patch } : a));
  }
  function add() {
    const next = [...value, {
      id: crypto.randomUUID(),
      category: 'detention' as const,
      description: '',
      amount: 0,
      billable: true,
    }];
    onChange(next);
  }
  function remove(idx: number) {
    onChange(value.filter((_, i) => i !== idx));
  }

  return (
    <div>
      {/* Header row. Render the "+ Accessorial" button only — when the
          list is empty we skip the bordered "None." placeholder, so the
          UI stays compact until the dispatcher actually adds something. */}
      <div className="flex items-center justify-between mb-2">
        <label className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--gc-text-3)' }}>
          Accessorials
        </label>
        <button type="button" onClick={add}
          className="flex items-center gap-1 text-xs font-semibold transition-opacity"
          style={{ color: ACC_COLOR, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
          onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
          onMouseLeave={e => (e.currentTarget.style.opacity = '1')}>
          <Plus size={12} /> Accessorial
        </button>
      </div>
      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((a, i) => (
            <div key={a.id} className="flex items-center gap-2 flex-wrap">
              <StyledSelect value={a.category}
                onChange={e => update(i, { category: e.target.value as typeof a.category })}
                style={{ ...iStyle, cursor: 'pointer', width: 140, flexShrink: 0 }}
                onFocus={focusH} onBlur={blurColor}>
                {ACCESSORIAL_CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </StyledSelect>
              <input type="text" value={a.description ?? ''}
                placeholder="Description"
                onChange={e => update(i, { description: e.target.value })}
                style={{ ...iStyle, flex: 1, minWidth: 140 }}
                onFocus={focusH} onBlur={blurColor} />
              <input type="number" value={a.amount ?? 0}
                placeholder="0.00"
                onChange={e => update(i, { amount: Number(e.target.value) || 0 })}
                style={{ ...iStyle, width: 110, flexShrink: 0, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}
                onFocus={focusH} onBlur={blurColor} />
              {/* Billable toggle — pill style matching EventModal. Off
                  by default keeps non-billable internal-cost rows out of
                  the broker invoice. */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>Billable</span>
                <button type="button" onClick={() => update(i, { billable: !a.billable })}
                  className="relative flex items-center shrink-0 rounded-full"
                  style={{ width: 32, height: 18, background: a.billable ? ACC_COLOR : '#dadce0', transition: 'background 150ms', cursor: 'pointer', border: 'none' }}>
                  <span className="absolute rounded-full bg-white"
                    style={{ width: 12, height: 12, left: 3, transform: a.billable ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
                </button>
              </div>
              {/* Pay Driver toggle — flips the accessorial into the
                  driver's payroll. Auto-defaults the payDriverName to
                  the first eligible driver when turned on, clears it
                  when turned off. Mirrors EventModal exactly. */}
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>Pay Driver</span>
                <button type="button" onClick={() => {
                  const next = !a.payToDriver;
                  update(i, {
                    payToDriver: next,
                    ...(next && payOpts.length > 0 && !a.payDriverName ? { payDriverName: payOpts[0] } : {}),
                    ...(!next ? { payDriverName: undefined } : {}),
                  });
                }}
                  className="relative flex items-center shrink-0 rounded-full"
                  style={{ width: 32, height: 18, background: a.payToDriver ? '#1e8e3e' : '#dadce0', transition: 'background 150ms', cursor: 'pointer', border: 'none' }}>
                  <span className="absolute rounded-full bg-white"
                    style={{ width: 12, height: 12, left: 3, transform: a.payToDriver ? 'translateX(14px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }} />
                </button>
              </div>
              {a.payToDriver && payOpts.length > 0 && (
                <StyledSelect
                  value={a.payDriverName ?? payOpts[0]}
                  onChange={e => update(i, { payDriverName: e.target.value })}
                  style={{ ...iStyle, cursor: 'pointer', width: 160, flexShrink: 0, borderColor: '#1e8e3e' }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#1e8e3e')}
                  onBlur={e => (e.currentTarget.style.borderColor = '#1e8e3e')}>
                  {payOpts.map(name => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </StyledSelect>
              )}
              <button type="button" onClick={() => remove(i)} title="Remove accessorial"
                style={{ color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontSize: 16, lineHeight: 1 }}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Internal notes composer ────────────────────────────────────────────
//
// Pinned thread of internal notes attached to the load. Same data model
// as EventModal (loads.internal_notes column). Empty state: dashed
// amber "+ Internal Note" button. Active state: yellow card with the
// existing notes + an optional composer textarea below. New notes flow
// up to the parent via onChange and ride along the normal Save flow.

function InternalNotesComposer({
  value, onChange, authorName,
}: {
  value: InternalNote[];
  onChange: (next: InternalNote[]) => void;
  authorName: string;
}) {
  const [composer, setComposer] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);

  function post() {
    const text = composer.trim();
    if (!text) return;
    const next: InternalNote = {
      id: crypto.randomUUID(),
      text,
      author: authorName ?? null,
      at: new Date().toISOString(),
    };
    onChange([...value, next]);
    setComposer('');
    setComposerOpen(false);
  }
  function remove(id: string) {
    onChange(value.filter(n => n.id !== id));
  }

  if (value.length === 0 && !composerOpen) {
    return (
      <button
        type="button"
        onClick={() => setComposerOpen(true)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          fontSize: 12, fontWeight: 600, padding: '4px 10px',
          borderRadius: 6, border: '1px dashed #d4a017',
          background: 'transparent', color: '#a16207', cursor: 'pointer',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = '#fef9c3'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
        <Plus size={12} /> Internal Note
      </button>
    );
  }

  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, background: '#fef9c3', border: '1px solid #fde68a' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <Pin size={13} style={{ color: '#a16207', flexShrink: 0 }} />
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: '#92400e' }}>
          Internal Notes
        </div>
      </div>
      {value.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: composerOpen ? 10 : 0 }}>
          {value.map((n) => (
            <div key={n.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, lineHeight: 1.4, color: '#78350f', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {n.text}
                </div>
                <div style={{ fontSize: 11, color: '#a16207', marginTop: 2 }}>
                  {n.author ? `${n.author}` : 'Unknown'}
                  {' · '}
                  {new Date(n.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
              <button
                type="button"
                onClick={() => remove(n.id)}
                title="Remove note"
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: '#a16207' }}
                onMouseEnter={e => { e.currentTarget.style.color = '#dc2626'; }}
                onMouseLeave={e => { e.currentTarget.style.color = '#a16207'; }}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {composerOpen ? (
        <div style={{ borderTop: value.length > 0 ? '1px solid #fde68a' : 'none', paddingTop: value.length > 0 ? 10 : 0 }}>
          <textarea
            value={composer}
            onChange={e => setComposer(e.target.value)}
            placeholder="Add a note. Pinned to this load. Never sent to driver or customer."
            rows={2}
            autoFocus
            style={{
              width: '100%', fontSize: 13, lineHeight: 1.4, color: '#78350f',
              background: 'transparent', border: 'none', outline: 'none', resize: 'vertical',
              fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => { setComposer(''); setComposerOpen(false); }}
              style={{ fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 4, border: 'none', background: 'transparent', color: '#a16207', cursor: 'pointer' }}>
              Cancel
            </button>
            <button
              type="button"
              disabled={!composer.trim()}
              onClick={post}
              style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 4, border: 'none', background: composer.trim() ? '#a16207' : '#fde68a', color: '#fff', cursor: composer.trim() ? 'pointer' : 'default' }}>
              Post
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          style={{ fontSize: 11, fontWeight: 600, padding: '3px 0', border: 'none', background: 'transparent', color: '#a16207', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Plus size={11} /> Add note
        </button>
      )}
    </div>
  );
}

// ─── Load history (audit log) ───────────────────────────────────────────
//
// Mirrors EventModal's history footer. Created-by line on top, plus an
// expandable list of audit entries when there are any. Renders in the
// org timezone so dispatchers across regions see the same timestamps.

function LoadHistorySection({ load, calendarTimezone }: {
  load: Load;
  calendarTimezone: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const auditLog = load.auditLog ?? [];
  const hasHistory = auditLog.length > 0;
  if (!load.createdByName && !hasHistory) return null;

  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: calendarTimezone,
    });

  // prevStart/newStart etc. are stored as NAIVE ISO ("YYYY-MM-DDTHH:mm")
  // — they already represent a wall-clock time in the org's tz. Parse
  // manually so the display doesn't double-shift.
  const fmtAuditTime = (iso?: string) => {
    if (!iso) return '—';
    const s = iso.includes(' ') ? iso.replace(' ', 'T') : iso;
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) return iso;
    const [, y, mo, d, hh, mm] = m;
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm));
    return dt.toLocaleString('en-US', {
      month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
      timeZone: 'UTC',
    });
  };
  const fmt$ = (n?: number) => n != null ? `$${n.toLocaleString()}` : '—';

  return (
    <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        <Clock size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
        {load.createdByName && (
          <>
            <span style={{ color: 'var(--gc-text-3)' }}>Created by</span>
            <span style={{ color: 'var(--gc-text-1)', fontWeight: 600 }}>{load.createdByName}</span>
            {load.createdAt && (
              <>
                <span style={{ color: 'var(--gc-text-3)' }}>·</span>
                <span style={{ color: 'var(--gc-text-3)' }}>{fmtDate(load.createdAt)}</span>
              </>
            )}
          </>
        )}
        {hasHistory && (
          <button
            type="button"
            onClick={() => setExpanded(x => !x)}
            style={{ marginLeft: 6, fontSize: 11, color: 'var(--gc-blue)', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}
          >
            {expanded ? 'Hide history' : `View full history (${auditLog.length})`}
          </button>
        )}
      </div>
      {expanded && hasHistory && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10 }}>
          {auditLog.map((entry, i) => {
            const b = (txt: string) => <strong style={{ fontWeight: 700 }}>{txt}</strong>;
            type Part = { key: string; node: React.ReactNode };
            const parts: Part[] = [];
            if (entry.prevDriverName !== undefined || entry.newDriverName !== undefined)
              parts.push({ key: 'driver', node: <>{b('Driver')} changed from {b(entry.prevDriverName || '—')} to {b(entry.newDriverName || '—')}</> });
            if (entry.prevLoadPrice !== undefined)
              parts.push({ key: 'lprice', node: <>{b('Load price')} changed from {b(fmt$(entry.prevLoadPrice))} to {b(fmt$(entry.newLoadPrice))}</> });
            if (entry.prevDriverPay !== undefined)
              parts.push({ key: 'dpay', node: <>{b('Driver pay')} changed from {b(fmt$(entry.prevDriverPay))} to {b(fmt$(entry.newDriverPay))}</> });
            if (entry.prevCustomerId !== undefined || entry.newCustomerId !== undefined)
              parts.push({ key: 'customer', node: <>{b('Customer')} changed from {b(entry.prevCustomerName || entry.prevBroker || '—')} to {b(entry.newCustomerName || entry.newBroker || '—')}</> });
            else if (entry.prevBroker !== undefined || entry.newBroker !== undefined)
              parts.push({ key: 'broker', node: <>{b('Customer')} changed from {b(entry.prevBroker || '—')} to {b(entry.newBroker || '—')}</> });
            if (entry.prevDispatcher !== undefined || entry.newDispatcher !== undefined)
              parts.push({ key: 'disp', node: <>{b('Dispatcher')} changed from {b(entry.prevDispatcher || '—')} to {b(entry.newDispatcher || '—')}</> });
            if (entry.prevPriority !== undefined || entry.newPriority !== undefined)
              parts.push({ key: 'priority', node: <>{b('Priority')} {entry.newPriority ? <>flagged {b('on')}</> : <>flag {b('removed')}</>}</> });
            if (entry.prevStart !== undefined || entry.newStart !== undefined)
              parts.push({ key: 'start', node: <>{b('Start')} changed from {b(fmtAuditTime(entry.prevStart))} to {b(fmtAuditTime(entry.newStart))}</> });
            if (entry.prevEnd !== undefined || entry.newEnd !== undefined)
              parts.push({ key: 'end', node: <>{b('End')} changed from {b(fmtAuditTime(entry.prevEnd))} to {b(fmtAuditTime(entry.newEnd))}</> });
            if (entry.prevBillingStatus !== undefined || entry.newBillingStatus !== undefined)
              parts.push({ key: 'billing', node: <>{b('Billing')} changed from {b(entry.prevBillingStatus || '—')} to {b(entry.newBillingStatus || '—')}</> });
            if (parts.length === 0) return null;
            return (
              <div key={i} style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--gc-text-2)' }}>
                <span style={{ color: 'var(--gc-text-3)' }}>
                  {entry.changedByName ?? 'Unknown'}
                  {entry.changedAt && <> · {fmtDate(entry.changedAt)}</>}
                </span>
                <div style={{ marginTop: 2 }}>
                  {parts.map((p, j) => (
                    <span key={p.key}>
                      {j > 0 && <span style={{ color: 'var(--gc-text-3)' }}> · </span>}
                      {p.node}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Billing card (bottom right) ────────────────────────────────────────

function BillingCard({
  load, customer, invoice, busy,
  onGenerate, onSendOrResend, onViewInvoice, onViewDocs, onOpenReview,
  onOpenCustomerProfile,
}: {
  load: Load;
  customer: Customer | undefined;
  invoice: Invoice | null;
  busy: null | 'generate' | 'send' | 'resend';
  onGenerate: () => void;
  onSendOrResend: () => void;
  onViewInvoice: () => void;
  onViewDocs: () => void;
  /** Open the closeout Review panel. Only used in the Pending state
   *  while the dispatcher is still verifying docs before releasing
   *  the load to billing. */
  onOpenReview: () => void;
  /** Open the BrokerProfileModal for the given customer id. The
   *  customer name in the header is a button that calls this so the
   *  dispatcher can jump into the customer record to edit invoice
   *  method / email / portal without leaving the load page. */
  onOpenCustomerProfile: (customerId: string) => void;
}) {
  const status = load.billingStatus ?? 'pending';

  // Treat a void invoice as "no invoice" — that's how the rest of the
  // app reasons about it (regenerate would rescue the void row, etc.).
  const activeInvoice = invoice && invoice.status !== 'void' ? invoice : null;
  const hasInvoice  = !!activeInvoice;
  const isSent      = activeInvoice?.status === 'sent' || activeInvoice?.status === 'paid';

  // Line items: linehaul + billable accessorials + computed total. Use
  // the server-maintained total_billable when present so the figure
  // matches the table elsewhere; fall back to linehaul + sum(accessorials).
  const linehaul = load.loadPrice ?? 0;
  const billableAccessorials = (load.accessorials ?? []).filter(a => a.billable && a.amount > 0);
  const accessorialsSum = billableAccessorials.reduce((s, a) => s + a.amount, 0);
  const total = load.totalBillable ?? (linehaul + accessorialsSum);

  // Billing-method chip + detail line. Email / portal each get an icon
  // + the contact value. When no method is configured we fall back to
  // a muted "no billing method configured" line so the operator knows
  // to update the customer record before sending.
  const method = customer?.invoiceMethod;
  const billingDetail = method === 'email'
    ? (customer?.invoiceEmail ?? '— No email on file —')
    : method === 'portal'
      ? (customer?.invoicePortal ?? '— No portal on file —')
      : null;

  return (
    <>
      <div className="px-5 py-3 flex items-center gap-2 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
        <Receipt size={14} style={{ color: 'var(--gc-text-3)' }} />
        <span className="text-[13px] font-bold" style={{ color: 'var(--gc-text-1)' }}>Billing</span>
        <BillingPill billingStatus={status} />
        {hasInvoice && (
          <span className="ml-auto text-[11px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
            Invoice <strong style={{ color: 'var(--gc-text-2)' }}>#{activeInvoice.invoiceNumber}</strong>
          </span>
        )}
      </div>
      <div className="p-5 space-y-4">
        {/* Customer + billing method */}
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
            Customer
          </div>
          {customer?.id ? (
            <button
              type="button"
              onClick={() => onOpenCustomerProfile(customer.id)}
              title="Open customer profile to edit invoicing settings"
              className="text-[13px] font-semibold underline decoration-dotted underline-offset-2 text-left transition-colors"
              style={{ color: 'var(--gc-text-1)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--gc-blue)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-1)')}>
              {customer.name}
            </button>
          ) : (
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              {load.broker ?? '— No customer linked —'}
            </div>
          )}
          {method && billingDetail && (
            <div className="mt-1.5 flex items-center gap-1.5 text-[12px]"
              style={{ color: 'var(--gc-text-2)' }}>
              {method === 'email' ? <Mail size={11} /> : <Globe size={11} />}
              <span className="truncate" title={billingDetail}>{billingDetail}</span>
            </div>
          )}
          {!method && (
            <div className="mt-1.5 text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
              No billing method configured — set email or portal on the customer profile.
            </div>
          )}
        </div>

        {/* Line items */}
        <div>
          <div className="text-[10px] uppercase tracking-wider font-bold mb-1.5" style={{ color: 'var(--gc-text-3)' }}>
            Line items
          </div>
          <div className="rounded-lg overflow-hidden text-[12.5px]"
            style={{ border: '1px solid var(--gc-border-light)' }}>
            <div className="flex items-center px-3 py-2"
              style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
              <span className="flex-1" style={{ color: 'var(--gc-text-1)' }}>Linehaul</span>
              <span className="tabular-nums font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                {moneyFmt.format(linehaul)}
              </span>
            </div>
            {billableAccessorials.map(a => (
              <div key={a.id} className="flex items-center px-3 py-2"
                style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                <span className="flex-1 truncate" style={{ color: 'var(--gc-text-2)' }}>
                  {accessorialLineLabel(a)}
                </span>
                <span className="tabular-nums" style={{ color: 'var(--gc-text-2)' }}>
                  {moneyFmt.format(a.amount)}
                </span>
              </div>
            ))}
            <div className="flex items-center px-3 py-2"
              style={{ background: 'var(--gc-bg)' }}>
              <span className="flex-1 font-bold uppercase tracking-wider text-[11px]"
                style={{ color: 'var(--gc-text-3)' }}>Total</span>
              <span className="tabular-nums font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
                {moneyFmt.format(total)}
              </span>
            </div>
          </div>
        </div>

        {/* Invoice meta dates — only when an invoice exists. Keeps the
            issued/due/paid timeline visible without crowding the empty
            state above. */}
        {hasInvoice && (
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <KeyVal label="Issued" value={fmtShortDate(activeInvoice.issuedAt)} />
            <KeyVal label="Due"    value={fmtShortDate(activeInvoice.dueAt)} />
            <KeyVal label="Paid"   value={fmtShortDate(activeInvoice.paidAt)} />
          </div>
        )}

        {/* Actions. Pending state (paperwork still being verified)
            replaces the invoice buttons with a doc-verification slot —
            Review opens the closeout panel and the badges read
            present/missing for each required-doc kind, same look as
            the Paperwork table (opaque tint = present, transparent
            dashed red = missing). Once the dispatcher releases the
            load it flips to Released and the invoice action stack
            takes over below. */}
        {status === 'pending' ? (
          <div className="space-y-2 pt-1">
            {/* Required-doc checklist. Renders ABOVE the action button
                so the dispatcher reads the gap (e.g. "missing scale
                ticket") before clicking through to the review panel. */}
            <DocPresenceList load={load} />
            <button onClick={onOpenReview}
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
              style={{ background: 'var(--gc-blue)', color: '#fff', border: 'none' }}>
              <ClipboardCheck size={12} /> Review Paperwork to Release
            </button>
          </div>
        ) : (
          <div className="space-y-1.5 pt-1">
            <button onClick={onGenerate}
              disabled={!!busy || (!hasInvoice && status !== 'verified')}
              title={!hasInvoice && status !== 'verified'
                ? 'Release the load for billing before generating.'
                : undefined}
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--gc-blue)', color: '#fff', border: 'none' }}>
              {busy === 'generate'
                ? <Loader2 size={12} className="animate-spin" />
                : hasInvoice ? <RefreshCw size={12} /> : <FilePlus size={12} />}
              {hasInvoice ? 'Regenerate Invoice' : 'Generate Invoice'}
            </button>
            <button onClick={onSendOrResend}
              disabled={!hasInvoice || !!busy}
              className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--gc-surface)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
              {busy === 'send' || busy === 'resend'
                ? <Loader2 size={12} className="animate-spin" />
                : <Send size={12} />}
              {isSent ? 'Resend Invoice' : 'Send Invoice'}
            </button>
            {hasInvoice ? (
              <button onClick={onViewInvoice}
                className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
                style={{ background: 'var(--gc-bg)', color: 'var(--gc-blue)', border: '1px solid #bfdbfe' }}>
                <Eye size={12} /> View Invoice
              </button>
            ) : (
              <button onClick={onViewDocs}
                className="w-full text-[12.5px] font-semibold px-3 py-2 rounded-lg inline-flex items-center justify-center gap-1.5 transition-colors"
                style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border)' }}>
                <FolderOpen size={12} /> View Docs
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Required-doc verification checklist. One row per expected doc with
 * a green check + "{Label} Uploaded" when present, or an amber
 * warning + "Missing {label}" when not. Stacked vertically above the
 * Review button so the dispatcher reads exactly what's missing before
 * clicking through.
 *
 * RC and POD are always required. Lumper / Scale ticket only when the
 * load has a matching accessorial line item — mirrors the Paperwork
 * table's conditional-required logic. BOL renders only when one is
 * already on file (it's a nice-to-have, not a release blocker).
 */
function DocPresenceList({ load }: { load: Load }) {
  const counts = load.documentCounts ?? {};
  const rcCount     = Math.max(counts.rate_con ?? 0, load.rateConPdf ? 1 : 0);
  const podCount    = counts.pod    ?? 0;
  const bolCount    = counts.bol    ?? 0;
  const lumperCount = counts.lumper ?? 0;
  const scaleCount  = counts.scale  ?? 0;

  const accs = load.accessorials ?? [];
  const needsLumper = accs.some(a => a.category === 'lumper');
  const needsScale  = accs.some(a => a.category === 'scale_ticket');

  type Row = { label: string; present: boolean; count: number };
  const rows: Row[] = [
    { label: 'Rate Con',     present: rcCount  > 0, count: rcCount  },
    { label: 'POD',          present: podCount > 0, count: podCount },
  ];
  if (needsLumper) rows.push({ label: 'Lumper receipt', present: lumperCount > 0, count: lumperCount });
  if (needsScale)  rows.push({ label: 'Scale ticket',   present: scaleCount  > 0, count: scaleCount  });
  // BOL — only surface when one's on file; otherwise the row would
  // read as a missing required doc which it isn't.
  if (bolCount > 0) rows.push({ label: 'BOL', present: true, count: bolCount });

  return (
    <div className="flex flex-col gap-1">
      {rows.map(r => <DocPresenceRow key={r.label} {...r} />)}
    </div>
  );
}

function DocPresenceRow({ label, present, count }: { label: string; present: boolean; count: number }) {
  if (present) {
    return (
      <div className="flex items-center gap-1.5 text-[12px]" style={{ color: '#166534' }}>
        <Check size={13} style={{ flexShrink: 0 }} />
        <span>{label} Uploaded{count > 1 ? ` (×${count})` : ''}</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 text-[12px]" style={{ color: '#b45309' }}>
      <AlertTriangle size={13} style={{ flexShrink: 0 }} />
      <span>Missing {label}</span>
    </div>
  );
}

/** Format a single accessorial as an invoice line label. Prefers the
 *  user-typed description when present so detention rows read as
 *  "Detention · 2 hours" instead of just "Detention". */
function accessorialLineLabel(a: import('@fleetcal/types').Accessorial): string {
  const kindLabel: Record<string, string> = {
    detention:    'Detention',
    lumper:       'Lumper',
    layover:      'Layover',
    scale_ticket: 'Scale ticket',
    extra_stop:   'Extra stop',
    other:        'Other',
  };
  const base = kindLabel[a.category] ?? a.category;
  const desc = a.description?.trim();
  return desc ? `${base} · ${desc}` : base;
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

/**
 * Toolbar billing-status select. Shows the current status as a colored
 * pill (same palette as BillingPill) with a native select layered on
 * top so dispatchers can flip lifecycle stages in one click. The
 * underlying API actions for each transition are handled by the
 * parent's setBillingStatus(); this is render-only otherwise.
 */
/**
 * Title-row load-status select. Same colored-pill + hidden-native-
 * select pattern as the calendar modal's status control. Palette
 * mirrors EventModal's STATUSES so the two surfaces share a visual
 * vocabulary for the lifecycle stages.
 */
function TitleStatusSelect({
  value, onChange,
}: {
  value: LoadStatus;
  onChange: (next: LoadStatus) => void;
}) {
  const palette: Record<LoadStatus, { bg: string; fg: string; border: string; label: string }> = {
    scheduled:  { bg: '#e8f0fe', fg: '#1a73e8', border: '#bcd0fb', label: 'Scheduled' },
    assigned:   { bg: '#ede9fe', fg: '#5b21b6', border: '#ddd6fe', label: 'Assigned' },
    dispatched: { bg: '#e8f0fe', fg: '#1558d6', border: '#bcd0fb', label: 'Dispatched' },
    en_route:   { bg: '#fef3e2', fg: '#e37400', border: '#fcd34d', label: 'En Route' },
    picked_up:  { bg: '#f3e5f5', fg: '#7b1fa2', border: '#e1bee7', label: 'Picked Up' },
    delivered:  { bg: '#e6f4ea', fg: '#188038', border: '#a8d5b3', label: 'Delivered' },
    cancelled:  { bg: '#fce8e6', fg: '#d93025', border: '#f4c5c0', label: 'Cancelled' },
    tonu:       { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d', label: 'TONU' },
    problem:    { bg: '#ffedd5', fg: '#c2410c', border: '#fdba74', label: 'Problem' },
  };
  const p = palette[value] ?? palette.scheduled;
  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
        style={{ background: p.bg, color: p.fg, border: `1px solid ${p.border}` }}>
        {p.label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as LoadStatus)}
        style={{
          position: 'absolute', inset: 0, width: '100%', height: '100%',
          opacity: 0, cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none',
          border: 'none', outline: 'none', background: 'transparent', padding: 0, margin: 0,
        }}>
        {Object.entries(palette).map(([k, v]) => (
          <option key={k} value={k}>{v.label}</option>
        ))}
      </select>
    </div>
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
