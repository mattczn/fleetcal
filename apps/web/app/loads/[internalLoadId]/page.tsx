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
import { useAuth, useUser } from '@clerk/nextjs';
import {
  ArrowLeft, Truck, Loader2, Receipt, MapPin,
  ExternalLink as ExternalLinkIcon, Eye, FileCheck2,
  CheckCircle2, Plus, Clock, Copy, RotateCcw,
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
  DriverPhoneCopy, InternalNoteButton,
} from '@/components/forms/EventModalForm';
import {
  SECTION_LABELS, getEnabledFieldsForSection,
  type FieldSection, type FieldDef,
} from '@/lib/fields';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { displayBrokerName } from '@/lib/customerMatch';
import type { Load, Invoice } from '@fleetcal/types';

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
function CopyBtn({ value, title = 'Copy' }: { value: string; title?: string }) {
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
        width: 24, height: 24, borderRadius: 4, flexShrink: 0,
        cursor: value ? 'pointer' : 'default',
        border: '1px solid var(--gc-border)',
        background: 'var(--gc-bg)',
        color: copied ? '#15803d' : 'var(--gc-text-3)',
        transition: 'color 120ms, background 120ms',
        opacity: value ? 1 : 0.4,
      }}
      onMouseEnter={e => { if (!copied && value) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!copied) e.currentTarget.style.background = 'var(--gc-bg)'; }}>
      {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
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
  const assets = useCalendarStore(s => s.assets);
  const drivers = useCalendarStore(s => s.drivers);
  const trailers = useCalendarStore(s => s.trailers);
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

  // Editable draft. Only fields the user has touched land here — we
  // overlay it on top of the canonical fetched load when rendering,
  // and turn it into a PATCH payload on save. Cleared after a
  // successful save / on Discard / when a different load loads.
  type LoadDraft = Partial<Pick<Load,
    'loadNum' | 'broker' | 'customerId' | 'dispatcher' |
    'trailerType' | 'trailerId' | 'trailerName' | 'trailerNum' |
    'commodity' | 'weight' |
    'loadPrice' | 'driverPay' |
    'notes' | 'specialInstructions' |
    'accessorials' | 'refNums' | 'stops'>>;
  const [draft, setDraft] = useState<LoadDraft>({});
  const [saving, setSaving] = useState(false);

  function patchDraft(patch: LoadDraft) {
    setDraft(d => ({ ...d, ...patch }));
  }
  function discardDraft() { setDraft({}); }

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
  useEffect(() => { setDraft({}); }, [primaryLoadId]);

  // Effective load = persisted row + any pending edits on top.
  const effective: Load | undefined = useMemo(
    () => primaryLeg ? { ...primaryLeg, ...draft } : undefined,
    [primaryLeg, draft],
  );
  const isDirty = Object.keys(draft).length > 0;

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
      const { stops: nextStops, ...loadPatch } = draft;
      if (Object.keys(loadPatch).length > 0) {
        await railway.updateLoad(primaryLeg.loadId, loadPatch);
      }
      if (nextStops !== undefined) {
        await railway.replaceStops(primaryLeg.id, { stops: nextStops });
      }
      setDraft({});
      bumpLoadEditTick();
      await refresh({ silent: true });
    } catch (e) {
      console.error('[load detail] save failed:', e);
      window.alert(`Save failed: ${(e as Error)?.message ?? 'Unknown error'}`);
    } finally {
      setSaving(false);
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

  const headerTitle = `Load #${primaryLeg.internalLoadId ?? internalLoadId}`;

  return (
    <AppShell title={headerTitle} icon={Truck} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-2 gap-3 overflow-hidden">
        {/* Top toolbar. Save / Discard surface only when there are
            pending edits — same dirty-detection rhythm EventModal
            uses, just lifted to the page header instead of the modal
            footer. */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => router.back()}
            className="text-[12px] font-medium px-2.5 py-1.5 rounded-lg inline-flex items-center gap-1.5 transition-colors"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            <ArrowLeft size={12} /> Back
          </button>
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

        <div className="flex-1 min-h-0 grid gap-3"
          style={{ gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1.4fr) minmax(0, 1fr)' }}>

          {/* Left — load fields, modal-styled */}
          <div className="rounded-xl flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', gridRow: '1 / 3' }}>
            {/* ui-scale-scope: inherits Settings → Appearance → "Calendar
                card text" sizing, exactly like EventModal does. */}
            <div className="ui-scale-scope flex-1 min-h-0 overflow-y-auto"
              style={{ ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1 } as React.CSSProperties}>
              <LoadFormPane
                primary={effective ?? primaryLeg}
                partner={partnerLeg}
                customerById={customerById}
                assets={assets}
                drivers={drivers}
                trailers={trailers}
                customers={customers}
                sectionOrder={sectionOrder}
                fieldSettings={fieldSettings}
                driverPayPct={driverPayPct}
                onOpenCustomerProfile={setCustomerProfileId}
                currentUserName={currentUserName}
                calendarTimezone={calendarTimezone}
                onChange={patchDraft}
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
      {customerProfileId && (
        <BrokerProfileModal
          initialBrokerId={customerProfileId}
          onClose={() => setCustomerProfileId(null)} />
      )}
    </AppShell>
  );
}

// ─── Left card — modal-styled form ──────────────────────────────────────

function LoadFormPane({
  primary, partner, customerById, assets, drivers, trailers, customers, sectionOrder, fieldSettings,
  driverPayPct, onOpenCustomerProfile, currentUserName, calendarTimezone, onChange,
}: {
  primary: Load;
  partner: Load | undefined;
  customerById: Map<string, { id: string; name: string }>;
  assets: { id: number; name?: string | null; unit?: string | null }[];
  drivers: { id?: number; name?: string; firstName?: string; lastName?: string; phone?: string }[];
  trailers: { id: number; name: string; trailerNumber?: string; activeTo?: string | null }[];
  customers: { name: string; aliases?: string[] }[];
  sectionOrder: FieldSection[];
  fieldSettings: Record<string, boolean>;
  /** Org default driver-pay percentage from settings.rateConSettings.
   *  Powers the "%" badge next to Driver Pay + the "Reset to default"
   *  affordance when the manual value diverges. null disables both. */
  driverPayPct: number | null;
  onOpenCustomerProfile: (customerId: string) => void;
  currentUserName: string;
  calendarTimezone: string;
  /** Patch into the draft. Each call merges into the page-level draft;
   *  the page diffs against the persisted load + builds the save
   *  payload. Pass `{ broker: 'X' }` to set, `{ broker: null }` to clear. */
  onChange: (patch: Partial<Load>) => void;
}) {
  const iStyle = inputStyle();
  const focusH = focusColor(LOAD_ACCENT);

  // ── Derived values ──────────────────────────────────────────────────
  // Linked customer is keyed off the FK, not text equality — same
  // approach EventModal uses. Avoids the "shows linked but the
  // customer_id is NULL" bug where the badge would light up just
  // because the broker text happened to match a customer name.
  const linkedCustomer = primary.customerId
    ? customerById.get(primary.customerId)
    : undefined;
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

  // Trailer dropdown — same StyledSelect look as the Driver / Truck
  // selects in Assignment. Sourced from `trailers` in the calendar
  // store; we surface the live row (even if retired) at the top so an
  // already-assigned retired trailer still displays correctly.
  const trailerOptions = useMemo(() => {
    const active = trailers.filter(t => !t.activeTo);
    const labelFor = (t: { name: string; trailerNumber?: string }) =>
      `${t.name}${t.trailerNumber ? ` #${t.trailerNumber}` : ''}`.trim();
    const items = active.map(t => ({ id: t.id, label: labelFor(t) }));
    // Surface the currently-attached trailer even if it's retired
    // (activeTo set) — otherwise the page would silently look unassigned.
    if (primary.trailerId != null && !items.some(i => i.id === primary.trailerId)) {
      const t = trailers.find(t => t.id === primary.trailerId);
      if (t) items.unshift({ id: t.id, label: `${labelFor(t)} (retired)` });
    }
    return items;
  }, [trailers, primary.trailerId]);

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

  // Render one field row by id. Broker, refNums, and textareas get
  // dedicated treatments; everything else is a single text/number
  // input wired through commitField.
  function renderField(field: FieldDef) {
    // Load # — text input + a copy-to-clipboard button on the right.
    // Same primitive Ref Numbers uses below so dispatchers can grab the
    // number into broker portals / Excel without highlighting.
    if (field.id === 'loadNum') {
      const v = fieldValue('loadNum');
      return (
        <Field label={field.label}>
          <div className="flex items-center gap-1.5">
            <input type="text" value={v}
              placeholder={field.placeholder}
              onChange={e => commitField('loadNum', e.target.value)}
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
            <CopyBtn value={v} title="Copy load number" />
          </div>
        </Field>
      );
    }
    // Trailer — StyledSelect off the trailers store (active first,
    // currently-assigned retired trailer shown for back-compat). Stores
    // back through trailerId + trailerName/trailerNum so the load row
    // stays in sync without a join. Empty value clears all three.
    if (field.id === 'trailer') {
      return (
        <Field label={field.label}>
          <StyledSelect
            value={primary.trailerId != null ? String(primary.trailerId) : ''}
            onChange={e => {
              const raw = e.target.value;
              if (!raw) {
                // Null sentinel — the API + converter both treat null as
                // "clear" (loads.ts coerces `?? null`). The Load type
                // models these as optional so cast through unknown to
                // satisfy TS without losing the clear semantics.
                onChange({ trailerId: null, trailerName: null, trailerNum: null } as unknown as Partial<Load>);
                return;
              }
              const id = Number(raw);
              const t = trailers.find(x => x.id === id);
              onChange({
                trailerId: id,
                trailerName: t?.name ?? null,
                trailerNum:  t?.trailerNumber ?? null,
              } as unknown as Partial<Load>);
            }}
            style={{ ...iStyle, cursor: 'pointer' }}
            onFocus={focusH} onBlur={blurColor}>
            <option value="">— No trailer —</option>
            {trailerOptions.map(t => (
              <option key={t.id} value={String(t.id)}>{t.label}</option>
            ))}
          </StyledSelect>
        </Field>
      );
    }
    // Driver Pay — same generic number input, but with the percentage
    // chip + reset button piped in as labelSuffix.
    if (field.id === 'driverPay') {
      return (
        <Field label={field.label} labelSuffix={driverPayLabelSuffix}>
          <input type="number" value={fieldValue('driverPay')}
            placeholder={field.placeholder}
            onChange={e => commitField('driverPay', e.target.value)}
            style={{ ...iStyle, fontVariantNumeric: 'tabular-nums' }}
            onFocus={focusH} onBlur={blurColor} />
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
            <input type="text" value={fieldValue('broker')}
              placeholder={field.placeholder}
              onChange={e => commitField('broker', e.target.value)}
              style={iStyle} onFocus={focusH} onBlur={blurColor} />
            {linkedCustomer && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl"
                  style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <CheckCircle2 size={13} style={{ color: '#16a34a', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: '#15803d' }}>
                    Linked to <strong>{linkedCustomer.name}</strong>
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
    // Ref numbers — list editor: label + value inputs per row plus a
    // remove button. The "+ Reference" button below appends an empty
    // row that the user fills in.
    if (field.id === 'refNums') {
      const refs = primary.refNums ?? [];
      const update = (idx: number, patch: Partial<typeof refs[number]>) =>
        onChange({ refNums: refs.map((r, i) => i === idx ? { ...r, ...patch } : r) });
      const add = () => onChange({ refNums: [...refs, { label: '', value: '' }] });
      const remove = (idx: number) =>
        onChange({ refNums: refs.filter((_, i) => i !== idx) });
      return (
        <Field label={field.label}>
          <div className="space-y-1.5">
            {refs.map((r, i) => (
              <div key={i} className="grid items-center gap-2"
                style={{ gridTemplateColumns: '1fr 1fr auto auto' }}>
                <input type="text" value={r.label}
                  placeholder="Label (PO #, BOL…)"
                  onChange={e => update(i, { label: e.target.value })}
                  style={{ ...iStyle, fontSize: 'calc(12px * var(--ui-scale, 1))' }}
                  onFocus={focusH} onBlur={blurColor} />
                <input type="text" value={r.value}
                  placeholder="Value"
                  onChange={e => update(i, { value: e.target.value })}
                  style={{ ...iStyle, fontVariantNumeric: 'tabular-nums' }}
                  onFocus={focusH} onBlur={blurColor} />
                <CopyBtn value={r.value} title={`Copy ${r.label || 'reference'}`} />
                <button type="button" onClick={() => remove(i)} title="Remove reference"
                  style={{ color: 'var(--gc-text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontSize: 16, lineHeight: 1 }}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" onClick={add}
              className="flex items-center gap-1 text-xs font-semibold transition-opacity"
              style={{ color: LOAD_ACCENT, background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
              <Plus size={12} /> Reference
            </button>
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
            onChange={e => commitField(field.id, e.target.value)}
            style={{ ...iStyle, resize: 'vertical', fontFamily: 'inherit', minHeight: 72 }}
            onFocus={focusH} onBlur={blurColor} />
        </Field>
      );
    }
    const isNumber = field.type === 'number';
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
          <StopsSection
            stops={primary.stops}
            onChange={(stops) => onChange({ stops })}
            headerColor={LOAD_ACCENT}
            onMapRoute={() => { /* page already shows the map on the right */ }}
            loadedMiles={loadedMiles}
            loadPrice={primary.loadPrice ?? null}
            ratePerMile={rpm}
          />
        </div>
      );
    }

    // Generic load/financial/notes section.
    const fields = getEnabledFieldsForSection(section, fieldSettings);
    if (fields.length === 0 && section !== 'financial') return null;

    return (
      <ModalSection key={section} title={SECTION_LABELS[section]} first={first}>
        {renderSectionFields(fields)}

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
          the same one). The bottom border uses LOAD_ACCENT. */}
      <input
        type="text"
        value={primary.title ?? ''}
        readOnly
        placeholder="No title"
        className="w-full bg-transparent outline-none font-medium"
        style={{
          fontSize: 22,
          borderBottom: `2px solid ${LOAD_ACCENT}`,
          paddingBottom: 8,
          color: 'var(--gc-text-1)',
          cursor: 'default',
        }}
      />

      {/* ── Assignment (always rendered first, above the user-ordered
          sections — matches EventModal's pinning of driver/asset above
          the load info). Driver phone chip sits below the driver field
          when we have one; + Internal Note lives at the bottom of the
          assignment block. */}
      <ModalSection title="Assignment" first>
        <div className="grid grid-cols-2 gap-4">
          <div>
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
            {primaryDriver?.phone && (
              <DriverPhoneCopy phone={primaryDriver.phone} />
            )}
          </div>
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

        {/* Relay: second driver/truck pair below the primary one. */}
        {partner && (
          <div className="grid grid-cols-2 gap-4 mt-4">
            <Field label="Delivery driver (relay)">
              <input type="text" value={partner.driverName ?? ''} readOnly
                placeholder="Unassigned"
                style={iStyle} onFocus={focusH} onBlur={blurColor} />
            </Field>
            <Field label="Delivery truck (relay)">
              <input type="text" value={truckLabel(assetById.get(partner.assetId))} readOnly
                placeholder="—"
                style={iStyle} onFocus={focusH} onBlur={blurColor} />
            </Field>
          </div>
        )}

        {/* + Internal Note button — matches EventModal placement
            (immediately under the driver/truck block, above the rest
            of the load info). Wired as render-only for now; the
            composer hook lands in a follow-up alongside save support. */}
        <div className="mt-4">
          <InternalNoteButton />
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
