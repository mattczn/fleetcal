'use client';

import { useRef, useState, useEffect } from 'react';
import { useOrganization } from '@clerk/nextjs';
import { ArrowLeft, GripVertical, LayoutList, Bot, ChevronDown, ChevronUp, Globe, Sun, Moon, Monitor, Plus, Pencil, Trash2, Check, X, Truck, Plug, Loader2, Layers, RefreshCw, MapPin, Users, Smartphone, FileText, Sparkles } from 'lucide-react';
import { CARD_FIELD_DEFS, CardFieldKey } from '@/lib/cardFields';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import DataLoader from '@/components/DataLoader';
import { ALL_FIELDS, DEFAULT_SECTION_ORDER, FieldDef, FieldSection, SECTION_LABELS, getEnabledFieldsForSection } from '@/lib/fields';
import { buildRateConPrompt } from '@/lib/prompt';

const PREVIEW_COLOR = '#1a73e8';

type NavItem = 'appearance' | 'timezone' | 'assets' | 'load-fields' | 'ratecon-ai' | 'invoicing' | 'integrations' | 'card-layout' | 'saved-locations' | 'dispatchers' | 'customers' | 'trailers' | 'driver-app';

// ─── Toggle ──────────────────────────────────────────────────────────────────

function Toggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: () => void }) {
  return (
    <button type="button" onClick={onChange} disabled={disabled && !checked}
      className="relative flex items-center shrink-0 rounded-full"
      style={{
        width: 36, height: 20,
        background: checked ? '#1a73e8' : '#dadce0',
        opacity: disabled && !checked ? 0.35 : 1,
        transition: 'background 150ms',
        cursor: disabled && !checked ? 'not-allowed' : 'pointer',
      }}>
      <span className="absolute rounded-full bg-white"
        style={{ width: 14, height: 14, left: 3, transform: checked ? 'translateX(16px)' : 'translateX(0)', transition: 'transform 150ms', boxShadow: '0 1px 3px rgba(0,0,0,.25)' }} />
    </button>
  );
}

// ─── Modal preview ────────────────────────────────────────────────────────────

function PField({ label, placeholder, tall }: { label: string; placeholder?: string; tall?: boolean; span?: boolean }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="w-full rounded-lg flex items-start px-3"
        style={{
          border: '1px solid var(--gc-border)',
          background: 'var(--gc-surface)',
          height: tall ? 72 : 40,
          paddingTop: tall ? 10 : 0,
          alignItems: tall ? 'flex-start' : 'center',
        }}>
        <span className="text-xs truncate" style={{ color: 'var(--gc-text-3)' }}>{placeholder ?? '—'}</span>
      </div>
    </div>
  );
}

function PSection({ label, fields }: { label: string; fields: FieldDef[] }) {
  if (fields.length === 0) return null;
  const rows: FieldDef[][] = [];
  let i = 0;
  while (i < fields.length) {
    const f = fields[i];
    if (f.type === 'boolean' || f.type === 'textarea' || f.span) { rows.push([f]); i++; }
    else {
      const next = fields[i + 1];
      if (next && next.type !== 'boolean' && next.type !== 'textarea' && !next.span) { rows.push([f, next]); i += 2; }
      else { rows.push([f]); i++; }
    }
  }
  return (
    <div style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 16, marginTop: 16 }}>
      <div className="text-[10px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="space-y-3">
        {rows.map((row, idx) => (
          <div key={idx} className={row.length === 2 ? 'grid grid-cols-2 gap-4' : ''}>
            {row.map(f => <PField key={f.id} label={f.label} placeholder={f.placeholder} tall={f.type === 'textarea'} span={f.span} />)}
          </div>
        ))}
      </div>
    </div>
  );
}

function ModalPreview({ fieldSettings, sectionOrder }: { fieldSettings: Record<string, boolean>; sectionOrder: FieldSection[] }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ boxShadow: 'var(--shadow-3)', border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
      {/* Header */}
      <div className="px-6 py-4 flex items-center justify-between"
        style={{ background: `${PREVIEW_COLOR}10`, borderBottom: `3px solid ${PREVIEW_COLOR}` }}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" style={{ background: PREVIEW_COLOR }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
            </svg>
          </div>
          <div>
            <div className="text-[9px] font-bold uppercase tracking-wider" style={{ color: PREVIEW_COLOR }}>New Load</div>
            <div className="text-xs font-medium" style={{ color: 'var(--gc-text-1)' }}>Truck 01 · Driver Name</div>
          </div>
        </div>
        <div className="rounded-lg px-3 py-1 text-[10px] font-semibold" style={{ background: '#e8f0fe', color: PREVIEW_COLOR }}>Scheduled</div>
      </div>

      {/* Body */}
      <div className="px-5 py-5">
        {/* Title bar */}
        <div className="mb-4 pb-2.5" style={{ borderBottom: `2px solid ${PREVIEW_COLOR}` }}>
          <span className="text-sm font-medium" style={{ color: 'var(--gc-text-3)' }}>Add title…</span>
        </div>
        {/* Date row */}
        <div className="grid grid-cols-2 gap-4 mb-3">
          <PField label="Start" placeholder="Apr 22, 2026  8:00 AM" />
          <PField label="End"   placeholder="Apr 22, 2026  5:00 PM" />
        </div>
        {/* Asset / Driver */}
        <div className="grid grid-cols-2 gap-4">
          <PField label="Asset" placeholder="Truck 01 (#142)" />
          <PField label="Driver" placeholder="— No driver —" />
        </div>

        {/* Load Info — always pinned directly below core fields */}
        <PSection label={SECTION_LABELS['load']} fields={getEnabledFieldsForSection('load', fieldSettings)} />

        {/* Remaining sections in user order */}
        {sectionOrder.map(section => {
          if (section === 'load') return null;
          if (section === 'locations') return (
            <div key="locations" style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 16, marginTop: 16 }}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#7c3aed' }}>Locations</div>
                <div className="text-xs px-2.5 py-0.5 rounded-lg font-medium" style={{ background: '#f5f3ff', color: '#7c3aed' }}>+ Add stop</div>
              </div>
              <div className="space-y-2">
                {(['Pickup', 'Delivery'] as const).map(lbl => (
                  <div key={lbl} className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg"
                    style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
                    <div className="rounded-full shrink-0" style={{ width: 7, height: 7, background: lbl === 'Pickup' ? '#22c55e' : '#ef4444' }} />
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>{lbl}</div>
                      <div className="text-xs" style={{ color: 'var(--gc-text-2)' }}>123 Main St, Chicago, IL</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
          const fields = getEnabledFieldsForSection(section, fieldSettings);
          return <PSection key={section} label={SECTION_LABELS[section]} fields={fields} />;
        })}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 flex items-center justify-end gap-2"
        style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
        <div className="px-4 py-1.5 rounded-lg text-xs font-medium" style={{ color: 'var(--gc-text-2)' }}>Cancel</div>
        <div className="px-4 py-1.5 rounded-lg text-xs font-semibold text-white" style={{ background: PREVIEW_COLOR }}>Create load</div>
      </div>
    </div>
  );
}

// ─── Load fields settings panel ───────────────────────────────────────────────

const SECTION_COLORS: Record<FieldSection, { bg: string; text: string; border: string }> = {
  load:      { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
  locations: { bg: '#f5f3ff', text: '#7c3aed', border: '#ddd6fe' },
  financial: { bg: '#f0fdf4', text: '#15803d', border: '#bbf7d0' },
  notes:     { bg: '#fefce8', text: '#a16207', border: '#fde68a' },
};

function FieldSectionCard({
  section, fieldSettings, atLimit, isOver,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onToggle,
}: {
  section: FieldSection;
  fieldSettings: Record<string, boolean>;
  atLimit: boolean;
  isOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
  onToggle: (id: string, on: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const c = SECTION_COLORS[section];
  const isLocations = section === 'locations';
  const fields = isLocations ? [] : ALL_FIELDS.filter(f => f.section === section);
  const enabledInSection = fields.filter(f => fieldSettings[f.id]).length;
  return (
    <div draggable onDragStart={onDragStart} onDragOver={onDragOver} onDrop={onDrop} onDragEnd={onDragEnd}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      className="rounded-2xl overflow-hidden"
      style={{ border: isOver ? '2px solid #1a73e8' : '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
      <div className="flex items-center gap-2.5 px-4 py-3"
        style={{ borderBottom: isLocations ? 'none' : '1px solid var(--gc-border-light)', background: c.bg }}>
        <div style={{ color: hovered ? c.text : 'transparent', transition: 'color 120ms', cursor: 'grab' }}>
          <GripVertical size={14} />
        </div>
        <span className="text-xs font-bold uppercase tracking-wider flex-1" style={{ color: c.text }}>{SECTION_LABELS[section]}</span>
        {isLocations
          ? <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{ background: c.border, color: c.text }}>Always shown</span>
          : <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{ background: c.border, color: c.text }}>{enabledInSection}/{fields.length}</span>
        }
      </div>
      {isLocations && (
        <div className="px-4 py-3">
          <p className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
            Stops, routing, and loaded mileage. On relay legs, the relay block also appears here above the stops.
            Drag this card to control where Locations appears in the load modal.
          </p>
        </div>
      )}
      {!isLocations && (
        <div>
          {fields.map((f, fi) => {
            const on = !!fieldSettings[f.id];
            return (
              <div key={f.id} className="flex items-center justify-between px-4 py-3 gap-4"
                style={{ borderTop: fi === 0 ? 'none' : '1px solid var(--gc-border-light)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium" style={{ color: on ? 'var(--gc-text-1)' : 'var(--gc-text-3)' }}>{f.label}</div>
                  {f.placeholder && (
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--gc-text-3)' }}>e.g. {f.placeholder}</div>
                  )}
                </div>
                <Toggle checked={on} disabled={atLimit} onChange={() => onToggle(f.id, on)} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LoadFieldsPanel() {
  const { fieldSettings, sectionOrder, setFieldEnabled, setSectionOrder, driverPayPct, setDriverPayPct, hasHydratedOrgSettings } = useCalendarStore();
  const [pctInput, setPctInput] = useState(driverPayPct != null ? String(driverPayPct) : '');

  // Field toggles are org-scoped; write through to the server so other
  // dispatchers see the same field set.
  const onFieldToggle = (id: string, on: boolean) => {
    setFieldEnabled(id, on);
    if (!hasHydratedOrgSettings) return; // pre-hydration toggles are noise
    const next = { ...fieldSettings, [id]: on };
    void import('@/lib/railway').then(({ railway }) =>
      railway.updateOrgSettings({ rateConSettings: { fieldSettings: next } }),
    ).catch((err) => console.error('[settings] field toggle sync failed:', err));
  };

  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const handleDragStart = (idx: number) => { dragIdx.current = idx; };
  const handleDragOver  = (e: React.DragEvent, idx: number) => { e.preventDefault(); if (dragIdx.current !== null && dragIdx.current !== idx) setOverIdx(idx); };
  const handleDrop = (idx: number) => {
    if (dragIdx.current !== null && dragIdx.current !== idx) {
      const next = [...sectionOrder];
      const [moved] = next.splice(dragIdx.current, 1);
      next.splice(idx, 0, moved);
      setSectionOrder(next);
    }
    dragIdx.current = null; setOverIdx(null);
  };
  const handleDragEnd = () => { dragIdx.current = null; setOverIdx(null); };

  const atLimit = false; // no cap — toggle any field freely

  return (
    <div className="flex gap-10 items-start">
      {/* ── Left: controls ── */}
      <div className="space-y-5" style={{ width: 380, flexShrink: 0 }}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Load Fields</h2>
            <p className="text-sm mt-1" style={{ color: 'var(--gc-text-2)' }}>
              Toggle fields · drag sections to reorder
            </p>
          </div>
          <button onClick={() => setSectionOrder(DEFAULT_SECTION_ORDER)}
            className="text-xs px-2.5 py-1 rounded-lg shrink-0"
            style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
            Reset order
          </button>
        </div>

        {/* Driver pay default */}
        <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
          <div className="flex items-center gap-2.5 px-4 py-3" style={{ borderBottom: '1px solid var(--gc-border-light)', background: '#f0fdf4' }}>
            <span className="text-xs font-bold uppercase tracking-wider flex-1" style={{ color: '#15803d' }}>Driver Pay Default</span>
            {driverPayPct != null && (
              <span className="text-xs px-2 py-0.5 rounded-lg font-medium" style={{ background: '#bbf7d0', color: '#15803d' }}>{driverPayPct}% of load price</span>
            )}
          </div>
          <div className="px-4 py-4 space-y-3">
            <p className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
              When a load price is entered, driver pay is automatically filled in at this percentage. You can still override it per load.
            </p>
            <div className="flex items-center gap-2">
              <div className="relative flex items-center" style={{ width: 120 }}>
                <input
                  type="number" min="0" max="100" step="0.1"
                  value={pctInput}
                  onChange={e => setPctInput(e.target.value)}
                  onBlur={() => {
                    const n = parseFloat(pctInput);
                    if (!pctInput.trim() || isNaN(n)) { setDriverPayPct(null); setPctInput(''); }
                    else { const clamped = Math.min(100, Math.max(0, n)); setDriverPayPct(clamped); setPctInput(String(clamped)); }
                  }}
                  placeholder="e.g. 70"
                  className="w-full rounded-lg px-3 text-sm"
                  style={{ height: 38, border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', outline: 'none', paddingRight: 28 }}
                  onFocus={e => (e.currentTarget.style.borderColor = '#15803d')}
                />
                <span className="absolute right-3 text-sm font-medium pointer-events-none" style={{ color: 'var(--gc-text-3)' }}>%</span>
              </div>
              {driverPayPct != null && (
                <button type="button" onClick={() => { setDriverPayPct(null); setPctInput(''); }}
                  className="text-xs px-2.5 py-1 rounded-lg"
                  style={{ color: 'var(--gc-text-3)', border: '1px solid var(--gc-border-light)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = '#dc2626'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Section cards */}
        <div className="space-y-3">
          {sectionOrder.map((section, idx) => (
            <FieldSectionCard key={section} section={section}
              fieldSettings={fieldSettings} atLimit={atLimit} isOver={overIdx === idx}
              onDragStart={() => handleDragStart(idx)} onDragOver={e => handleDragOver(e, idx)}
              onDrop={() => handleDrop(idx)} onDragEnd={handleDragEnd}
              onToggle={(id, on) => onFieldToggle(id, !on)}
            />
          ))}
        </div>
      </div>

      {/* ── Right: live preview — centered, ~half the available space ── */}
      <div className="flex-1 min-w-0 flex flex-col items-center">
        <div style={{ width: '65%', minWidth: 320 }}>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--gc-text-3)' }}>
            Live Preview
          </div>
          <ModalPreview fieldSettings={fieldSettings} sectionOrder={sectionOrder} />
        </div>
      </div>
    </div>
  );
}

// ─── General panel ────────────────────────────────────────────────────────────

const TIMEZONES = [
  { label: 'Pacific Time',  value: 'Pacific Time (America/Los_Angeles)',  iana: 'America/Los_Angeles' },
  { label: 'Mountain Time', value: 'Mountain Time (America/Denver)',      iana: 'America/Denver'      },
  { label: 'Central Time',  value: 'Central Time (America/Chicago)',      iana: 'America/Chicago'     },
  { label: 'Eastern Time',  value: 'Eastern Time (America/New_York)',     iana: 'America/New_York'    },
];

const THEMES: { value: 'light' | 'dark' | 'system'; label: string; icon: React.ReactNode }[] = [
  { value: 'light',  label: 'Light',  icon: <Sun  size={14} /> },
  { value: 'system', label: 'System', icon: <Monitor size={14} /> },
  { value: 'dark',   label: 'Dark',   icon: <Moon size={14} /> },
];

function AppearancePanel() {
  const { theme, setTheme, showStatusOverlay, setShowStatusOverlay, showUnassigned, setShowUnassigned } = useCalendarStore();
  return (
    <div style={{ width: 560 }} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Appearance</h2>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
          Saved per member — only affects your view.
        </p>
      </div>
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Theme</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Choose how Dispatch looks on your device.</div>
        </div>
        <div className="p-5">
          <div className="grid grid-cols-3 gap-2">
            {THEMES.map(t => {
              const active = theme === t.value;
              return (
                <button key={t.value} onClick={() => setTheme(t.value)}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
                  style={{
                    border: `1px solid ${active ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
                    background: active ? 'var(--gc-blue-light)' : 'transparent',
                    color: active ? 'var(--gc-blue)' : 'var(--gc-text-2)',
                  }}>
                  {t.icon}
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Calendar</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Control what's shown on load cards.</div>
        </div>
        <div className="divide-y" style={{ borderColor: 'var(--gc-border-light)' }}>
          <div className="px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>Status overlay</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Show a status badge on each load card (Scheduled, En Route, Delivered…)</div>
            </div>
            <Toggle checked={showStatusOverlay} disabled={false} onChange={() => setShowStatusOverlay(!showStatusOverlay)} />
          </div>
          <div className="px-5 py-4 flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>Unassigned column</div>
              <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Show an Unassigned column as the first column — use it as a placeholder when a truck hasn't been assigned yet.</div>
            </div>
            <Toggle checked={showUnassigned} disabled={false} onChange={() => setShowUnassigned(!showUnassigned)} />
          </div>
        </div>
      </div>
    </div>
  );
}

function DriverAppPanel() {
  const [showDriverPay, setShowDriverPay] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    import('@/lib/railway').then(({ railway }) => railway.getOrgSettings())
      .then(({ settings }) => { if (!cancelled) setShowDriverPay(settings.showDriverPay); })
      .catch(() => { if (!cancelled) setShowDriverPay(false); });
    return () => { cancelled = true; };
  }, []);

  async function toggle() {
    if (showDriverPay == null || busy) return;
    const next = !showDriverPay;
    setBusy(true);
    setShowDriverPay(next); // optimistic
    try {
      const { railway } = await import('@/lib/railway');
      await railway.updateOrgSettings({ showDriverPay: next });
    } catch {
      setShowDriverPay(!next); // roll back
    }
    setBusy(false);
  }

  return (
    <div style={{ width: 560 }} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Driver App</h2>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
          Settings that control what drivers see in the mobile app.
        </p>
      </div>

      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4 flex items-center gap-4">
          <div className="flex-1">
            <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Show driver pay</div>
            <div className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--gc-text-3)' }}>
              When on, drivers see the Pay amount on each load. When off, the Pay row is hidden.
            </div>
          </div>
          {showDriverPay == null
            ? <Loader2 size={16} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
            : <Toggle checked={showDriverPay} disabled={busy} onChange={toggle} />}
        </div>
      </div>
    </div>
  );
}

function TimezonePanel() {
  const { promptVariables, setPromptVariable, calendarTimezone, setCalendarTimezone, hasHydratedOrgSettings } = useCalendarStore();
  // Timezone affects the rate-con prompt; sync to org settings so all
  // dispatchers parse with the same TZ.
  const syncTimezone = (value: string) => {
    if (!hasHydratedOrgSettings) return;
    void import('@/lib/railway').then(({ railway }) =>
      railway.updateOrgSettings({ rateConSettings: { promptVariables: { ...promptVariables, timezone: value } } }),
    ).catch((err) => console.error('[settings] timezone sync failed:', err));
  };
  return (
    <div style={{ width: 560 }} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Timezone</h2>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
          Sets the timezone for the calendar display, current time indicator, and rate con AI parsing.
        </p>
      </div>
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Your timezone</div>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            {TIMEZONES.map(tz => {
              const active = calendarTimezone === tz.iana;
              return (
                <button key={tz.value} onClick={() => {
                  setCalendarTimezone(tz.iana);
                  setPromptVariable('timezone', tz.value);
                  syncTimezone(tz.value);
                }}
                  className="px-4 py-2.5 rounded-xl text-sm font-medium text-left transition-colors"
                  style={{
                    border: `1px solid ${active ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
                    background: active ? 'var(--gc-blue-light)' : 'transparent',
                    color: active ? 'var(--gc-blue)' : 'var(--gc-text-1)',
                  }}>
                  {tz.label}
                </button>
              );
            })}
          </div>
          <div className="pt-1">
            <div className="text-xs mb-1.5" style={{ color: 'var(--gc-text-3)' }}>Or enter a custom IANA timezone (e.g. America/Phoenix):</div>
            <input
              type="text"
              value={calendarTimezone}
              onChange={e => {
                setCalendarTimezone(e.target.value);
                setPromptVariable('timezone', e.target.value);
                syncTimezone(e.target.value);
              }}
              className="w-full rounded-lg text-sm outline-none"
              style={{ border: '1px solid var(--gc-border)', padding: '8px 12px', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Rate Con AI panel ────────────────────────────────────────────────────────

const VARIABLE_DEFS: { key: keyof import('@/lib/prompt').PromptVariables; label: string; description: string; rows: number }[] = [
  {
    key: 'systemRole',
    label: 'System role',
    description: 'The opening instruction that defines how the AI approaches the document.',
    rows: 2,
  },
  {
    key: 'titleFormat',
    label: 'Load title format',
    description: 'How the AI should compose the load title when parsing a rate con.',
    rows: 3,
  },
  {
    key: 'specialInstructionsFormat',
    label: 'Special instructions format',
    description: 'How the AI should fill the Special Instructions field. Stop-level info (addresses, appointment times, gate codes for a specific stop) is already extracted into the stops array — this should focus on load-level customer requirements.',
    rows: 7,
  },
];

function VarTextarea({ label, description, value, rows, onChange }: {
  label: string; description: string; value: string; rows: number; onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="font-medium text-sm mb-0.5" style={{ color: 'var(--gc-text-1)' }}>{label}</div>
      <div className="text-xs mb-2" style={{ color: 'var(--gc-text-3)' }}>{description}</div>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        rows={rows}
        className="w-full rounded-xl text-sm resize-none outline-none"
        style={{
          border: '1px solid var(--gc-border)',
          padding: '10px 12px',
          color: 'var(--gc-text-1)',
          background: 'var(--gc-bg)',
          lineHeight: '1.55',
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
        }}
        onFocus={e => (e.currentTarget.style.borderColor = '#1a73e8')}
        onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
      />
    </div>
  );
}

function RateConAIPanel({ setActive }: { setActive: (v: NavItem) => void }) {
  const { fieldSettings, promptInstructions, setPromptInstructions, promptVariables, setPromptVariable, hasHydratedOrgSettings } = useCalendarStore();
  const [showCompiled, setShowCompiled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const enabledFieldIds = Object.keys(fieldSettings).filter(k => fieldSettings[k]);
  const previewVars = editing
    ? { ...promptVariables, ...draft }
    : promptVariables;
  const compiled = buildRateConPrompt(enabledFieldIds, promptInstructions, previewVars as typeof promptVariables);

  // Debounced sync of promptInstructions (freeform textarea) to the server.
  // Skip the first render after hydration so we don't echo back the value
  // we just received.
  useEffect(() => {
    if (!hasHydratedOrgSettings) return;
    const t = setTimeout(() => {
      void import('@/lib/railway').then(({ railway }) =>
        railway.updateOrgSettings({ rateConSettings: { promptInstructions } }),
      ).catch((err) => console.error('[settings] promptInstructions sync failed:', err));
    }, 700);
    return () => clearTimeout(t);
  }, [promptInstructions, hasHydratedOrgSettings]);

  const startEdit = () => {
    const d: Record<string, string> = {};
    VARIABLE_DEFS.forEach(def => { d[def.key] = promptVariables[def.key]; });
    setDraft(d);
    setEditing(true);
  };

  const confirmEdit = () => {
    const nextVars = { ...promptVariables };
    VARIABLE_DEFS.forEach(def => {
      if (draft[def.key] !== undefined) {
        setPromptVariable(def.key, draft[def.key]);
        nextVars[def.key] = draft[def.key];
      }
    });
    setEditing(false);
    setDraft({});
    void import('@/lib/railway').then(({ railway }) =>
      railway.updateOrgSettings({ rateConSettings: { promptVariables: nextVars } }),
    ).catch((err) => console.error('[settings] promptVariables sync failed:', err));
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft({});
  };

  return (
    <div style={{ width: 560 }} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Rate Con AI</h2>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
          When you upload a rate con PDF, Claude reads it and fills in your enabled load fields automatically. Edit the formatting variables below to control how specific fields are written, then add any customer-specific instructions in the custom instructions box.
        </p>
      </div>

      {/* Formatting variables */}
      <div className="rounded-2xl overflow-hidden" style={{ border: editing ? '1px solid #1a73e8' : '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)', transition: 'border-color 150ms' }}>
        <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div>
            <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Formatting variables</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {editing ? 'Editing — changes preview in the compiled prompt below but are not saved yet.' : 'Control how the AI formats specific fields.'}
            </div>
          </div>
          {!editing ? (
            <button onClick={startEdit}
              className="px-4 py-2 rounded-lg text-xs font-semibold transition-colors"
              style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'var(--gc-surface)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-surface)'; e.currentTarget.style.color = 'var(--gc-text-2)'; }}>
              Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button onClick={cancelEdit}
                className="px-4 py-2 rounded-lg text-xs font-medium transition-colors"
                style={{ color: 'var(--gc-text-2)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                Cancel
              </button>
              <button onClick={confirmEdit}
                className="px-4 py-2 rounded-lg text-xs font-semibold text-white transition-colors"
                style={{ background: '#1a73e8' }}
                onMouseEnter={e => (e.currentTarget.style.background = '#1557b0')}
                onMouseLeave={e => (e.currentTarget.style.background = '#1a73e8')}>
                Confirm changes
              </button>
            </div>
          )}
        </div>
        <div className="p-5 space-y-5">
          {VARIABLE_DEFS.map(def => {
            const current = editing ? (draft[def.key] ?? '') : promptVariables[def.key];
            return editing ? (
              <VarTextarea
                key={def.key}
                label={def.label}
                description={def.description}
                value={current}
                rows={def.rows}
                onChange={v => setDraft(d => ({ ...d, [def.key]: v }))}
              />
            ) : (
              <div key={def.key}>
                <div className="font-medium text-sm mb-0.5" style={{ color: 'var(--gc-text-1)' }}>{def.label}</div>
                <div className="text-xs mb-2" style={{ color: 'var(--gc-text-3)' }}>{def.description}</div>
                <div className="rounded-lg px-3 py-2 whitespace-pre-wrap" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: '1.55' }}>
                  {current}
                </div>
              </div>
            );
          })}
          <div>
            <div className="font-medium text-sm mb-0.5" style={{ color: 'var(--gc-text-1)' }}>Timezone</div>
            <div className="text-xs mb-2" style={{ color: 'var(--gc-text-3)' }}>
              All appointment times will be converted to this timezone.{' '}
              <button onClick={() => setActive('timezone')} className="underline underline-offset-2" style={{ color: 'var(--gc-blue)' }}>
                Change in General settings
              </button>
            </div>
            <div className="rounded-lg px-3 py-2" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-2)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
              {promptVariables.timezone}
            </div>
          </div>
        </div>
      </div>

      {/* Custom instructions */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Custom instructions</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
            Customer-specific or company-specific guidance appended to every parse request.
          </div>
        </div>
        <div className="p-5 space-y-3">
          <textarea
            value={promptInstructions}
            onChange={e => setPromptInstructions(e.target.value)}
            placeholder={'Examples:\n• Echo Global Logistics always puts the load # after "Order:"\n• Coyote rate cons use "BOL" in the header for the reference number\n• All appointment times are Central Time — convert to Mountain'}
            rows={5}
            className="w-full rounded-xl text-sm resize-none outline-none"
            style={{
              border: '1px solid var(--gc-border)',
              padding: '10px 12px',
              color: 'var(--gc-text-1)',
              background: 'var(--gc-bg)',
              lineHeight: '1.6',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
            }}
            onFocus={e => (e.currentTarget.style.borderColor = '#1a73e8')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          />
          <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
            {enabledFieldIds.length} field{enabledFieldIds.length !== 1 ? 's' : ''} currently enabled — the AI will try to extract all of them.
          </div>
        </div>
      </div>

      {/* Compiled prompt (collapsible) */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <button
          onClick={() => setShowCompiled(v => !v)}
          className="w-full flex items-center justify-between px-5 py-4 text-left transition-colors"
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          <div>
            <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Compiled prompt</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              Exactly what gets sent to Claude when you parse a PDF — updates live as you edit above
            </div>
          </div>
          {showCompiled
            ? <ChevronUp size={16} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
            : <ChevronDown size={16} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />}
        </button>
        {showCompiled && (
          <div style={{ borderTop: '1px solid var(--gc-border-light)' }}>
            <pre className="px-5 py-4 text-xs overflow-x-auto whitespace-pre-wrap" style={{ color: 'var(--gc-text-2)', fontFamily: 'ui-monospace, monospace', lineHeight: '1.65', background: 'var(--gc-bg)', margin: 0 }}>
              {compiled}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Assets panel ────────────────────────────────────────────────────────────

function AssetsPanel() {
  const { assetCategories, addAssetCategory, updateAssetCategory, removeAssetCategory, reorderAssetCategories } = useCalendarStore();
  const [newName, setNewName]   = useState('');
  const [editIdx, setEditIdx]   = useState<number | null>(null);
  const [editVal, setEditVal]   = useState('');
  const dragIdx = useRef<number | null>(null);
  const [overIdx, setOverIdx]   = useState<number | null>(null);

  const handleAdd = () => {
    const trimmed = newName.trim();
    if (!trimmed || assetCategories.includes(trimmed)) return;
    addAssetCategory(trimmed);
    setNewName('');
  };

  const startEdit = (idx: number) => {
    setEditIdx(idx);
    setEditVal(assetCategories[idx]);
  };

  const confirmEdit = () => {
    if (editIdx === null) return;
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== assetCategories[editIdx] && !assetCategories.includes(trimmed)) {
      updateAssetCategory(assetCategories[editIdx], trimmed);
    }
    setEditIdx(null);
  };

  const cancelEdit = () => setEditIdx(null);

  return (
    <div style={{ width: 560 }} className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Asset Categories</h2>
        <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
          Define the categories available when creating or editing assets. Renaming a category updates all assigned assets.
        </p>
      </div>

      {/* Category list */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>Categories</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Drag to reorder.</div>
        </div>

        {assetCategories.length === 0 && (
          <div className="px-5 py-8 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            No categories yet — add one below.
          </div>
        )}

        <div className="divide-y" style={{ borderColor: 'var(--gc-border-light)' }}>
          {assetCategories.map((cat, idx) => (
            <div
              key={cat}
              draggable
              onDragStart={() => { dragIdx.current = idx; }}
              onDragOver={e => { e.preventDefault(); if (dragIdx.current !== null && dragIdx.current !== idx) setOverIdx(idx); }}
              onDrop={() => { if (dragIdx.current !== null && dragIdx.current !== idx) reorderAssetCategories(dragIdx.current, idx); dragIdx.current = null; setOverIdx(null); }}
              onDragEnd={() => { dragIdx.current = null; setOverIdx(null); }}
              className="flex items-center gap-3 px-5 py-3"
              style={{ background: overIdx === idx ? 'var(--gc-hover)' : 'transparent' }}
            >
              <GripVertical size={14} style={{ color: 'var(--gc-text-3)', cursor: 'grab', flexShrink: 0 }} />

              {editIdx === idx ? (
                <input
                  autoFocus
                  value={editVal}
                  onChange={e => setEditVal(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') confirmEdit(); if (e.key === 'Escape') cancelEdit(); }}
                  className="flex-1 rounded-lg px-2.5 py-1 text-sm outline-none"
                  style={{ border: '1px solid var(--gc-blue)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
                />
              ) : (
                <span className="flex-1 text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{cat}</span>
              )}

              {editIdx === idx ? (
                <div className="flex items-center gap-1">
                  <button onClick={confirmEdit} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-blue)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <Check size={14} />
                  </button>
                  <button onClick={cancelEdit} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <button onClick={() => startEdit(idx)} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <Pencil size={13} />
                  </button>
                  <button onClick={() => removeAssetCategory(cat)} className="p-1.5 rounded-full transition-colors" style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = '#d93025'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Add new */}
        <div className="px-5 py-4 flex items-center gap-2" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="New category name…"
            className="flex-1 rounded-lg px-3 py-2 text-sm outline-none"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}
            onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
            onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
          />
          <button
            onClick={handleAdd}
            disabled={!newName.trim() || assetCategories.includes(newName.trim())}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-40"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={e => { if (newName.trim()) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
            <Plus size={14} />
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Integrations Panel ───────────────────────────────────────────────────────

interface MotiveVehicle { id: string; number: string; year: number | null; make: string | null; model: string | null; }
interface MatchSuggestion { motiveId: string; assetId: number; confidence: 'high' | 'medium' | 'low'; }

const CONFIDENCE_LABEL = { high: '●', medium: '◑', low: '○' };
const CONFIDENCE_COLOR = { high: '#16a34a', medium: '#b45309', low: '#9ca3af' };

function vehicleLabel(v: MotiveVehicle) {
  const parts = [v.number ? `#${v.number}` : `ID ${v.id}`];
  if (v.year)  parts.push(String(v.year));
  if (v.make)  parts.push(v.make);
  if (v.model) parts.push(v.model);
  return parts.join(' ');
}

// ─── Invoicing panel ──────────────────────────────────────────────────────────
//
// Lets the user fill in everything that prints on a generated invoice:
// company letterhead, MC/DOT, billing address, payment terms, remit-to
// instructions, optional factor info, optional footer notes / number
// prefix. Settings live on org_settings.invoice_settings (JSONB) so we
// can iterate on the shape without DDL.
function InvoicingPanel() {
  // Clerk org provides company name (and logo via imageUrl) — pre-fill
  // those when invoice settings haven't been written yet, so the
  // dispatcher doesn't have to retype info that already exists.
  const { organization: clerkOrg } = useOrganization();
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [err,     setErr]     = useState<string | null>(null);
  // Track which fields were auto-filled from Clerk (vs explicitly
  // saved) so we can show a subtle "auto-filled" hint and not save
  // the prefilled value unless the user explicitly touches it.
  const [autofilledFromClerk, setAutofilledFromClerk] = useState<Set<string>>(new Set());

  // Single state blob keyed to InvoiceSettings — keeps the form
  // straightforward. Empty strings for unset fields so the inputs
  // always have a controlled value.
  type Form = {
    companyName: string; mcNumber: string; dotNumber: string; ein: string;
    addressLine1: string; addressLine2: string; city: string; state: string; zip: string;
    phone: string; email: string;
    defaultPaymentTermsDays: string;
    remitToInstructions: string;
    invoiceFooterNotes: string;
    invoiceNumberPrefix: string;
  };
  const emptyForm: Form = {
    companyName:             '',
    mcNumber:                '',
    dotNumber:               '',
    ein:                     '',
    addressLine1:            '',
    addressLine2:            '',
    city:                    '',
    state:                   '',
    zip:                     '',
    phone:                   '',
    email:                   '',
    defaultPaymentTermsDays: '',
    remitToInstructions:     '',
    invoiceFooterNotes:      '',
    invoiceNumberPrefix:     '',
  };
  const [form, setForm] = useState<Form>(emptyForm);
  // Snapshot of the last-saved (or freshly-loaded) state. Compared
  // against `form` to detect unsaved edits — we use that to gate the
  // beforeunload guard so the user gets a "leave with unsaved changes?"
  // browser prompt if they try to navigate away mid-edit.
  const [savedSnapshot, setSavedSnapshot] = useState<Form>(emptyForm);
  const isDirty = JSON.stringify(form) !== JSON.stringify(savedSnapshot);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Modern browsers ignore the returnValue text but still need it
      // set to trigger the native prompt. Cross-browser-safe shape.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  const updateField = (key: keyof Form, value: string) => {
    setForm(prev => ({ ...prev, [key]: value }));
    setSaved(false);
    // User edited this field — drop the "auto-filled" badge.
    if (autofilledFromClerk.has(key as string)) {
      setAutofilledFromClerk(prev => {
        const next = new Set(prev);
        next.delete(key as string);
        return next;
      });
    }
  };

  // Hydrate on mount.
  useEffect(() => {
    let cancelled = false;
    void import('@/lib/railway').then(({ railway }) => railway.getOrgSettings())
      .then(({ settings }) => {
        if (cancelled) return;
        const inv = settings.invoiceSettings ?? {};
        // Clerk fallbacks — only used when the saved field is empty.
        // Currently just companyName (Clerk org.name); other fields
        // (address, MC#, EIN) aren't standard Clerk org properties.
        const clerkAutofills: Record<string, string | undefined> = {
          companyName: clerkOrg?.name ?? undefined,
        };
        const filled = new Set<string>();
        const pick = (saved: string | undefined, key: string): string => {
          if (saved && saved.length > 0) return saved;
          const fallback = clerkAutofills[key];
          if (fallback && fallback.length > 0) { filled.add(key); return fallback; }
          return '';
        };
        const next: Form = {
          companyName:             pick(inv.companyName, 'companyName'),
          mcNumber:                inv.mcNumber                ?? '',
          dotNumber:               inv.dotNumber               ?? '',
          ein:                     inv.ein                     ?? '',
          addressLine1:            inv.addressLine1            ?? '',
          addressLine2:            inv.addressLine2            ?? '',
          city:                    inv.city                    ?? '',
          state:                   inv.state                   ?? '',
          zip:                     inv.zip                     ?? '',
          phone:                   inv.phone                   ?? '',
          email:                   inv.email                   ?? '',
          defaultPaymentTermsDays: inv.defaultPaymentTermsDays != null ? String(inv.defaultPaymentTermsDays) : '',
          remitToInstructions:     inv.remitToInstructions     ?? '',
          invoiceFooterNotes:      inv.invoiceFooterNotes      ?? '',
          invoiceNumberPrefix:     inv.invoiceNumberPrefix     ?? '',
        };
        setForm(next);
        // Snapshot the loaded state as the new baseline — the form
        // is "clean" relative to what's in the DB. Auto-filled-from-
        // Clerk fields are intentionally part of the snapshot so we
        // don't nag the user about leaving when nothing has actually
        // changed since load.
        setSavedSnapshot(next);
        setAutofilledFromClerk(filled);
        setLoading(false);
      })
      .catch(e => {
        if (cancelled) return;
        console.error('[InvoicingPanel] fetch failed:', e);
        setErr((e as Error).message ?? 'Failed to load');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [clerkOrg?.name]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const { railway } = await import('@/lib/railway');
      const parsedTerms = form.defaultPaymentTermsDays.trim() === '' ? undefined : parseInt(form.defaultPaymentTermsDays, 10);
      // Send only non-empty strings as values; empty input → undefined
      // so the JSONB stores a clean record instead of "" everywhere.
      const cleaned: Partial<import('@fleetcal/types').InvoiceSettings> = {
        companyName:             form.companyName.trim()             || undefined,
        mcNumber:                form.mcNumber.trim()                || undefined,
        dotNumber:               form.dotNumber.trim()                || undefined,
        ein:                     form.ein.trim()                     || undefined,
        addressLine1:            form.addressLine1.trim()            || undefined,
        addressLine2:            form.addressLine2.trim()            || undefined,
        city:                    form.city.trim()                    || undefined,
        state:                   form.state.trim()                   || undefined,
        zip:                     form.zip.trim()                     || undefined,
        phone:                   form.phone.trim()                   || undefined,
        email:                   form.email.trim()                   || undefined,
        defaultPaymentTermsDays: Number.isFinite(parsedTerms) ? parsedTerms : undefined,
        remitToInstructions:     form.remitToInstructions.trim()     || undefined,
        invoiceFooterNotes:      form.invoiceFooterNotes.trim()      || undefined,
        invoiceNumberPrefix:     form.invoiceNumberPrefix.trim()     || undefined,
      };
      await railway.updateOrgSettings({ invoiceSettings: cleaned });
      // Snapshot moves forward to the just-saved values so the form
      // is "clean" again and the beforeunload guard relaxes.
      setSavedSnapshot(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      console.error('[InvoicingPanel] save failed:', e);
      setErr((e as Error).message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm" style={{ width: 640, color: 'var(--gc-text-3)' }}>
        <Loader2 size={16} className="animate-spin" /> Loading invoice settings…
      </div>
    );
  }

  return (
    <div className="flex items-start gap-8" style={{ minWidth: 1440 }}>
      {/* Left: form */}
      <div className="space-y-6" style={{ width: 560, flexShrink: 0 }}>
        <div>
          <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Invoicing</h2>
          <p className="text-sm mt-1.5 leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
            Letterhead, contact info, and payment instructions that appear on every invoice you generate.
            Per-broker invoice routing (email vs portal) lives on each customer&rsquo;s profile.
          </p>
          {clerkOrg && (
            <div className="text-xs mt-2 flex items-center gap-1.5" style={{ color: 'var(--gc-text-3)' }}>
              <Sparkles size={12} />
              Company name auto-fills from your Clerk org ({clerkOrg.name}).
              {clerkOrg.imageUrl && <> Logo from your Clerk org image is used on the invoice.</>}
            </div>
          )}
        </div>

      {/* Company identity */}
      <Card title="Company identity" subtitle="Carrier info printed at the top of every invoice.">
        <FieldRow
          label="Company name"
          subtitle="As it should appear on the invoice (legal entity or DBA).">
          <div className="flex-1 flex flex-col gap-1">
            <Input value={form.companyName} onChange={v => updateField('companyName', v)} placeholder="Acme Trucking LLC" />
            {autofilledFromClerk.has('companyName') && (
              <div className="text-[11px] flex items-center gap-1" style={{ color: '#7b1fa2' }}>
                <Sparkles size={11} /> Auto-filled from your Clerk organization. Edit + save to override.
              </div>
            )}
          </div>
        </FieldRow>
        <FieldRow label="MC #">
          <Input value={form.mcNumber} onChange={v => updateField('mcNumber', v)} placeholder="MC-123456" />
        </FieldRow>
        <FieldRow label="DOT #">
          <Input value={form.dotNumber} onChange={v => updateField('dotNumber', v)} placeholder="1234567" />
        </FieldRow>
        <FieldRow label="EIN" subtitle="Tax ID. Some brokers require it on the invoice.">
          <Input value={form.ein} onChange={v => updateField('ein', v)} placeholder="12-3456789" />
        </FieldRow>
      </Card>

      {/* Billing address */}
      <Card title="Billing address" subtitle="Used as the &ldquo;from&rdquo; block on the invoice.">
        <FieldRow label="Address line 1">
          <Input value={form.addressLine1} onChange={v => updateField('addressLine1', v)} placeholder="123 Main St" />
        </FieldRow>
        <FieldRow label="Address line 2" subtitle="Suite / unit (optional)">
          <Input value={form.addressLine2} onChange={v => updateField('addressLine2', v)} placeholder="Suite 200" />
        </FieldRow>
        <FieldRow label="City">
          <Input value={form.city} onChange={v => updateField('city', v)} placeholder="Salt Lake City" />
        </FieldRow>
        <FieldRow label="State / ZIP">
          <div className="grid grid-cols-2 gap-2 flex-1">
            <Input value={form.state} onChange={v => updateField('state', v.toUpperCase())} placeholder="UT" maxLength={2} />
            <Input value={form.zip} onChange={v => updateField('zip', v)} placeholder="84101" />
          </div>
        </FieldRow>
      </Card>

      {/* Contact */}
      <Card title="Contact" subtitle="Shown on invoices so brokers know who to ask about payment.">
        <FieldRow label="AR / accounting email">
          <Input value={form.email} onChange={v => updateField('email', v)} placeholder="ar@acmetrucking.com" type="email" />
        </FieldRow>
        <FieldRow label="Phone">
          <Input value={form.phone} onChange={v => updateField('phone', v)} placeholder="(555) 123-4567" />
        </FieldRow>
      </Card>

      {/* Payment terms + remit-to */}
      <Card title="Payment" subtitle="How and when brokers should pay.">
        <FieldRow label="Default payment terms (days)" subtitle="Net 30 = 30. Brokers can override on their profile.">
          <Input value={form.defaultPaymentTermsDays}
            onChange={v => updateField('defaultPaymentTermsDays', v.replace(/[^\d]/g, ''))}
            placeholder="30" />
        </FieldRow>
        <FieldRow label="Remit-to instructions" subtitle="Free-form block at the bottom of the invoice.">
          <div className="flex-1 flex flex-col gap-1">
            <Textarea value={form.remitToInstructions} onChange={v => updateField('remitToInstructions', v)}
              placeholder={'Make checks payable to:\nAcme Trucking LLC\nP.O. Box 1234, Salt Lake City, UT 84101\n\nACH inquiries: ar@acmetrucking.com'}
              rows={6} />
            <div className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              <strong style={{ color: '#92400e' }}>Heads-up:</strong> invoices travel through brokers, AP staff, and factor archives.
              Putting full ACH routing + account numbers in plain text on the invoice exposes them widely.
              Safer pattern: bank name + last-4 digits, with &ldquo;Contact AR for full ACH details.&rdquo;
            </div>
          </div>
        </FieldRow>
      </Card>

      {/* Template tweaks */}
      <Card title="Template" subtitle="Optional overrides for the generated invoice.">
        <FieldRow label="Invoice number prefix" subtitle="Prepended to the load&rsquo;s internal ID. Leave blank to use the ID by itself.">
          <Input value={form.invoiceNumberPrefix} onChange={v => updateField('invoiceNumberPrefix', v)} placeholder="INV-" />
        </FieldRow>
        <FieldRow label="Footer notes" subtitle="Optional. Prints under the totals on every invoice.">
          <Textarea value={form.invoiceFooterNotes} onChange={v => updateField('invoiceFooterNotes', v)}
            placeholder="Thank you for your business. Payment due per terms above."
            rows={3} />
        </FieldRow>
      </Card>

        {/* Save bar */}
        <div className="flex items-center gap-3">
          <button onClick={() => void save()} disabled={saving}
            className="flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-bold text-white transition-colors disabled:opacity-50"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && (
            <span className="text-sm font-semibold flex items-center gap-1.5" style={{ color: '#15803d' }}>
              <Check size={14} /> Saved
            </span>
          )}
          {!saved && isDirty && !saving && (
            <span className="text-sm font-semibold" style={{ color: '#92400e' }}>
              Unsaved changes
            </span>
          )}
          {err && (
            <span className="text-sm" style={{ color: '#d93025' }}>{err}</span>
          )}
        </div>
      </div>{/* end left column */}

      {/* Right: sticky mock invoice preview. Renders directly from the
          form state so the user sees their changes immediately. Uses
          fixed sample data for load/broker/line-items since real load
          rendering happens in Phase 2 — this is just for visualizing
          the letterhead + payment block layout. */}
      <div className="flex-1 sticky top-0" style={{ minWidth: 840 }}>
        <div className="text-xs font-bold uppercase tracking-wider mb-2"
          style={{ color: 'var(--gc-text-3)' }}>
          Preview
        </div>
        <MockInvoice form={form} clerkOrg={clerkOrg} />
      </div>
    </div>
  );
}

// ─── Mock invoice preview ─────────────────────────────────────────────────────
//
// Live preview of what a generated invoice will look like with the
// current InvoicingPanel values. Sample load + broker + line items
// are hard-coded; this is purely a layout / letterhead visualizer for
// the settings panel. The Phase-2 invoice renderer will use this same
// general shape, replacing the sample data with real load data.

function MockInvoice({ form, clerkOrg }: {
  form: {
    companyName: string; mcNumber: string; dotNumber: string; ein: string;
    addressLine1: string; addressLine2: string; city: string; state: string; zip: string;
    phone: string; email: string;
    defaultPaymentTermsDays: string;
    remitToInstructions: string;
    invoiceFooterNotes: string;
    invoiceNumberPrefix: string;
  };
  clerkOrg: { name?: string; imageUrl?: string } | null | undefined;
}) {
  const companyName = form.companyName || clerkOrg?.name || 'Your Company Name';
  const cityLine    = [form.city, form.state].filter(Boolean).join(', ');
  const csz         = [cityLine, form.zip].filter(Boolean).join(' ');
  const issueDate   = new Date();
  const termsDays   = parseInt(form.defaultPaymentTermsDays, 10);
  const dueDate     = new Date(issueDate);
  if (Number.isFinite(termsDays)) dueDate.setDate(dueDate.getDate() + termsDays);
  const fmtDate = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const invoiceNum  = `${form.invoiceNumberPrefix || ''}15920358`;
  // Hard-coded sample so the preview is meaningful even when invoice
  // settings are empty.
  const sample = {
    broker:     'Acme Brokerage, LLC',
    brokerAddr: '500 Broker Way\nDallas, TX 75201',
    loadNum:    'L-0042',
    pickup:     'Apr 23, 2026 — Salt Lake City, UT',
    delivery:   'Apr 25, 2026 — Dallas, TX',
    miles:      1198,
    lineHaul:   2400,
    detention:  150,
    lumper:     85,
  };
  const total = sample.lineHaul + sample.detention + sample.lumper;
  return (
    <div className="rounded-xl overflow-hidden"
      style={{
        background: '#fff',
        border:     '1px solid var(--gc-border)',
        boxShadow:  '0 8px 24px rgba(0,0,0,0.08)',
        // Aspect roughly matches an 8.5x11" page at this width.
        aspectRatio: '8.5 / 11',
        // 1.75× the previous 520 — bigger preview so the user can
        // really see the layout.
        maxWidth: 910,
      }}>
      {/* All inner sizes scaled down so the page reads like a real
          letter-size document rather than a poster. Body is 10px,
          headers 14–17px, micro-labels 8px. */}
      <div className="h-full overflow-y-auto px-12 py-10 text-[#202124] text-[10px] leading-normal"
        style={{ fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
        {/* Header: company on left, logo + invoice meta on right */}
        <div className="flex items-start justify-between mb-7">
          <div>
            <div className="text-[17px] font-extrabold leading-tight">{companyName}</div>
            <div className="mt-1.5 leading-snug" style={{ color: '#5f6368' }}>
              {form.addressLine1 || <span style={{ opacity: 0.4 }}>Street address</span>}<br/>
              {form.addressLine2 && <>{form.addressLine2}<br/></>}
              {csz || <span style={{ opacity: 0.4 }}>City, ST ZIP</span>}
            </div>
            <div className="mt-1.5 leading-snug" style={{ color: '#5f6368' }}>
              {form.phone && <>P: {form.phone}<br/></>}
              {form.email && <>{form.email}<br/></>}
              {form.mcNumber  && <>MC# {form.mcNumber}{form.dotNumber && <> · DOT# {form.dotNumber}</>}{form.ein && <> · EIN {form.ein}</>}</>}
              {!form.mcNumber && form.dotNumber && <>DOT# {form.dotNumber}{form.ein && <> · EIN {form.ein}</>}</>}
              {!form.mcNumber && !form.dotNumber && form.ein && <>EIN {form.ein}</>}
            </div>
          </div>
          <div className="text-right shrink-0 ml-4">
            {clerkOrg?.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={clerkOrg.imageUrl} alt="" style={{ maxWidth: 64, maxHeight: 64, marginLeft: 'auto', marginBottom: 8 }} />
            )}
            <div className="text-[15px] font-extrabold tracking-wide" style={{ color: '#1a73e8' }}>INVOICE</div>
            <div className="mt-1.5 leading-snug" style={{ color: '#5f6368' }}>
              <div><span className="font-bold" style={{ color: '#202124' }}>#</span> {invoiceNum}</div>
              <div>Issued {fmtDate(issueDate)}</div>
              <div>Due {Number.isFinite(termsDays) ? fmtDate(dueDate) : '—'}</div>
            </div>
          </div>
        </div>

        {/* Bill-to */}
        <div className="mb-5">
          <div className="text-[8px] font-extrabold uppercase tracking-wider mb-1" style={{ color: '#5f6368' }}>Bill to</div>
          <div className="font-bold">{sample.broker}</div>
          <div className="leading-snug whitespace-pre-line" style={{ color: '#5f6368' }}>{sample.brokerAddr}</div>
        </div>

        {/* Load detail */}
        <div className="mb-5">
          <div className="text-[8px] font-extrabold uppercase tracking-wider mb-1" style={{ color: '#5f6368' }}>Load</div>
          <div><span className="font-bold">{sample.loadNum}</span> · {sample.miles.toLocaleString()} mi</div>
          <div style={{ color: '#5f6368' }}>Pickup: {sample.pickup}</div>
          <div style={{ color: '#5f6368' }}>Delivery: {sample.delivery}</div>
        </div>

        {/* Line items */}
        <table className="w-full mb-5" style={{ borderCollapse: 'collapse', fontSize: 10 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #dadce0' }}>
              <th className="text-left py-1.5 font-extrabold uppercase tracking-wider text-[8px]" style={{ color: '#5f6368' }}>Description</th>
              <th className="text-right py-1.5 font-extrabold uppercase tracking-wider text-[8px]" style={{ color: '#5f6368' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: '1px solid #f0f1f3' }}>
              <td className="py-1.5">Line haul ({sample.miles.toLocaleString()} mi)</td>
              <td className="py-1.5 text-right tabular-nums">${sample.lineHaul.toLocaleString()}.00</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f1f3' }}>
              <td className="py-1.5">Detention</td>
              <td className="py-1.5 text-right tabular-nums">${sample.detention.toLocaleString()}.00</td>
            </tr>
            <tr style={{ borderBottom: '1px solid #f0f1f3' }}>
              <td className="py-1.5">Lumper</td>
              <td className="py-1.5 text-right tabular-nums">${sample.lumper.toLocaleString()}.00</td>
            </tr>
            <tr>
              <td className="pt-2 font-extrabold text-[11px]">Total due</td>
              <td className="pt-2 text-right font-extrabold text-[11px] tabular-nums">${total.toLocaleString()}.00</td>
            </tr>
          </tbody>
        </table>

        {/* Remit-to */}
        {form.remitToInstructions ? (
          <div className="mb-4 px-3 py-2.5 rounded" style={{ background: '#f1f3f4' }}>
            <div className="text-[8px] font-extrabold uppercase tracking-wider mb-1" style={{ color: '#5f6368' }}>Remit to</div>
            <div className="whitespace-pre-line leading-snug">{form.remitToInstructions}</div>
          </div>
        ) : (
          <div className="mb-4 px-3 py-2.5 rounded text-[9px] italic" style={{ background: '#f1f3f4', color: '#5f6368' }}>
            Remit-to instructions appear here.
          </div>
        )}

        {/* Footer notes */}
        {form.invoiceFooterNotes && (
          <div className="text-[9px] leading-snug mt-3" style={{ color: '#5f6368' }}>
            {form.invoiceFooterNotes}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Tiny presentational helpers (panel-local) ────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
        <div className="font-semibold text-sm" style={{ color: 'var(--gc-text-1)' }}>{title}</div>
        {subtitle && <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{subtitle}</div>}
      </div>
      <div className="p-5 space-y-4">{children}</div>
    </div>
  );
}

function FieldRow({ label, subtitle, children }: { label: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4">
      <div style={{ width: 200, flexShrink: 0 }}>
        <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{label}</div>
        {subtitle && <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{subtitle}</div>}
      </div>
      <div className="flex-1 flex">{children}</div>
    </div>
  );
}

function Input({ value, onChange, placeholder, type = 'text', maxLength }: { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; maxLength?: number }) {
  return (
    <input type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      maxLength={maxLength}
      className="w-full text-sm px-3 py-2 rounded-lg outline-none transition-colors"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
        color:      'var(--gc-text-1)',
      }}
      onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
      onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
    />
  );
}

function Textarea({ value, onChange, placeholder, rows }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows ?? 3}
      className="w-full text-sm px-3 py-2 rounded-lg outline-none resize-y transition-colors"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border)',
        color:      'var(--gc-text-1)',
        minHeight:  60,
      }}
      onFocus={e => (e.currentTarget.style.borderColor = 'var(--gc-blue)')}
      onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
    />
  );
}

function IntegrationsPanel() {
  const { assets: allAssets, unassignedAssetId, updateAsset } = useCalendarStore();
  const assets = allAssets.filter(a => a.id !== unassignedAssetId);

  // ── API key state ─────────────────────────────────────────────────────────
  const [apiKey,     setApiKey]     = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [keySaving,  setKeySaving]  = useState(false);
  const [keySaved,   setKeySaved]   = useState(false);
  const [keyError,   setKeyError]   = useState('');

  useEffect(() => {
    fetch('/api/motive/key')
      .then(r => r.json())
      .then((d: { configured?: boolean }) => setConfigured(!!d.configured))
      .catch(() => setConfigured(false));
  }, []);

  const handleSaveKey = async () => {
    setKeySaving(true); setKeyError(''); setKeySaved(false);
    try {
      const res = await fetch('/api/motive/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: apiKey }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Save failed');
      setConfigured(!!apiKey);
      setApiKey('');
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 3000);
    } catch (e) {
      setKeyError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setKeySaving(false);
    }
  };

  const handleClearKey = async () => {
    setKeySaving(true); setKeyError('');
    try {
      await fetch('/api/motive/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: '' }) });
      setConfigured(false); setApiKey('');
    } catch { setKeyError('Failed to clear key'); }
    finally { setKeySaving(false); }
  };

  // ── Matcher state ─────────────────────────────────────────────────────────
  const [showMatcher,   setShowMatcher]   = useState(false);
  const [matchLoading,  setMatchLoading]  = useState(false);
  const [matchError,    setMatchError]    = useState('');
  const [motiveVehicles, setMotiveVehicles] = useState<MotiveVehicle[]>([]);
  // assignments: motiveId → assetId (or '' for unmatched)
  const [assignments,   setAssignments]   = useState<Record<string, string>>({});
  const [applying,      setApplying]      = useState(false);
  const [applied,       setApplied]       = useState(false);

  const handleOpenMatcher = async () => {
    setShowMatcher(true);
    setMatchLoading(true);
    setMatchError('');
    setApplied(false);

    try {
      // 1. Fetch Motive vehicles
      const vRes = await fetch('/api/motive/vehicles');
      if (!vRes.ok) throw new Error((await vRes.json()).error ?? 'Failed to fetch vehicles');
      const { vehicles } = await vRes.json() as { vehicles: MotiveVehicle[] };
      setMotiveVehicles(vehicles);

      // 2. Ask AI for suggestions
      const mRes = await fetch('/api/motive/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          motiveVehicles: vehicles,
          calendarAssets: assets.map(a => ({ id: a.id, name: a.name, unit: a.unit, truck: a.truck, type: a.type })),
        }),
      });
      const { suggestions = [] } = mRes.ok ? await mRes.json() as { suggestions: MatchSuggestion[] } : {};

      // 3. Seed assignments: AI suggestions first, then existing saved IDs
      const init: Record<string, string> = {};
      for (const v of vehicles) {
        const existing = assets.find(a => a.motiveVehicleId === v.id);
        if (existing) { init[v.id] = String(existing.id); }
      }
      for (const s of suggestions) {
        if (!init[s.motiveId]) init[s.motiveId] = String(s.assetId);
      }
      setAssignments(init);
    } catch (e) {
      setMatchError(e instanceof Error ? e.message : 'Error loading vehicles');
    } finally {
      setMatchLoading(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);

    // Build: assetId → motiveId (or undefined to clear)
    const assetMap: Record<number, string | undefined> = {};
    for (const asset of assets) assetMap[asset.id] = undefined; // clear all first
    for (const [motiveId, assetIdStr] of Object.entries(assignments)) {
      if (assetIdStr) assetMap[Number(assetIdStr)] = motiveId;
    }
    for (const [assetIdStr, motiveId] of Object.entries(assetMap)) {
      updateAsset(Number(assetIdStr), { motiveVehicleId: motiveId });
    }

    setApplying(false);
    setApplied(true);
    setTimeout(() => { setApplied(false); setShowMatcher(false); }, 1500);
  };

  const matchedCount = Object.values(assignments).filter(Boolean).length;

  return (
    <div style={{ maxWidth: 680 }}>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Integrations</h2>
      <p className="text-sm mb-8" style={{ color: 'var(--gc-text-3)' }}>
        Connect third-party services to enhance your dispatch board.
      </p>

      {/* Motive card */}
      <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>

        {/* Header */}
        <div className="flex items-center gap-4 px-6 py-5" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: '#0070f3' }}>
            <Plug size={18} color="white" />
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>Motive (KeepTruckin)</div>
            <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>Live truck locations in calendar column headers</div>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full"
              style={{ background: configured === null ? 'var(--gc-border)' : configured ? '#16a34a' : '#9ca3af' }} />
            <span className="text-xs font-medium" style={{ color: 'var(--gc-text-3)' }}>
              {configured === null ? '…' : configured ? 'Connected' : 'Not connected'}
            </span>
          </div>
        </div>

        {/* API key section */}
        <div className="px-6 py-5" style={{ borderBottom: showMatcher ? '1px solid var(--gc-border-light)' : 'none' }}>
          <p className="text-sm mb-4" style={{ color: 'var(--gc-text-2)' }}>
            Enter your Motive API key. It is stored securely server-side and never exposed to the browser.
          </p>
          <div className="flex gap-3 mb-3">
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={configured ? '••••••••••••  (leave blank to keep existing)' : 'Paste API key…'}
              className="flex-1 text-sm rounded-xl px-4 py-2.5 outline-none"
              style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-bg)', color: 'var(--gc-text-1)', transition: 'border-color 150ms' }}
              onFocus={e => (e.currentTarget.style.borderColor = '#1a73e8')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--gc-border)')}
              onKeyDown={e => { if (e.key === 'Enter' && apiKey) handleSaveKey(); }}
            />
            <button onClick={handleSaveKey} disabled={keySaving || !apiKey}
              className="px-5 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-40"
              style={{ background: '#1a73e8' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = '#1a73e8')}>
              {keySaving ? 'Saving…' : keySaved ? 'Saved ✓' : 'Save'}
            </button>
          </div>
          {keyError && <p className="text-xs mb-3" style={{ color: '#d93025' }}>{keyError}</p>}

          <div className="flex items-center gap-4">
            {configured && (
              <>
                <button
                  onClick={() => { if (!showMatcher) handleOpenMatcher(); else setShowMatcher(false); }}
                  className="flex items-center gap-1.5 text-sm font-medium px-4 py-2 rounded-xl transition-colors"
                  style={{ background: 'var(--gc-blue-light)', color: 'var(--gc-blue)' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.85')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  {showMatcher ? 'Hide matcher' : '✦ Match assets with AI'}
                </button>
                <button onClick={handleClearKey} disabled={keySaving}
                  className="text-xs transition-colors"
                  style={{ color: 'var(--gc-text-3)' }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#d93025')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--gc-text-3)')}>
                  Disconnect
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Matcher panel ── */}
        {showMatcher && (
          <div className="px-6 py-5">
            {matchLoading ? (
              <div className="flex items-center gap-2 py-6 justify-center" style={{ color: 'var(--gc-text-3)' }}>
                <Loader2 size={16} className="animate-spin" />
                <span className="text-sm">Fetching Motive vehicles and running AI match…</span>
              </div>
            ) : matchError ? (
              <p className="text-sm py-4 text-center" style={{ color: '#d93025' }}>{matchError}</p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-4">
                  <p className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>
                    {motiveVehicles.length} Motive vehicles · {matchedCount} matched
                  </p>
                  <p className="text-xs" style={{ color: 'var(--gc-text-3)' }}>
                    <span style={{ color: CONFIDENCE_COLOR.high }}>●</span> high &nbsp;
                    <span style={{ color: CONFIDENCE_COLOR.medium }}>◑</span> medium &nbsp;
                    <span style={{ color: CONFIDENCE_COLOR.low }}>○</span> low
                  </p>
                </div>

                {/* Table */}
                <div className="rounded-xl overflow-hidden mb-4" style={{ border: '1px solid var(--gc-border-light)' }}>
                  {/* Header */}
                  <div className="grid text-[10px] font-bold uppercase tracking-widest px-4 py-2.5"
                    style={{ gridTemplateColumns: '1fr 24px 1fr', background: 'var(--gc-bg)', color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border-light)' }}>
                    <span>Motive Vehicle</span>
                    <span />
                    <span>Calendar Asset</span>
                  </div>

                  {motiveVehicles.map((v, i) => {
                    const selectedAssetId = assignments[v.id] ?? '';
                    const isLast = i === motiveVehicles.length - 1;
                    return (
                      <div
                        key={v.id}
                        className="grid items-center px-4 py-3"
                        style={{
                          gridTemplateColumns: '1fr 24px 1fr',
                          borderBottom: isLast ? 'none' : '1px solid var(--gc-border-light)',
                          background: selectedAssetId ? 'transparent' : 'rgba(0,0,0,0.01)',
                        }}
                      >
                        {/* Motive vehicle info */}
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate" style={{ color: 'var(--gc-text-1)' }}>
                            {vehicleLabel(v)}
                          </div>
                          <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                            ID {v.id}
                          </div>
                        </div>

                        {/* Arrow */}
                        <div className="text-center text-base" style={{ color: selectedAssetId ? 'var(--gc-blue)' : 'var(--gc-border)' }}>
                          →
                        </div>

                        {/* Asset dropdown */}
                        <select
                          value={selectedAssetId}
                          onChange={e => setAssignments(prev => ({ ...prev, [v.id]: e.target.value }))}
                          className="text-sm rounded-lg px-3 outline-none"
                          style={{
                            height: 36,
                            border: `1px solid ${selectedAssetId ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                            background: 'var(--gc-bg)',
                            color: selectedAssetId ? 'var(--gc-text-1)' : 'var(--gc-text-3)',
                            cursor: 'pointer',
                            width: '100%',
                          }}
                        >
                          <option value="">— No match —</option>
                          {assets.map(a => (
                            <option key={a.id} value={String(a.id)}>
                              {a.name}{a.unit ? ` #${a.unit}` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                    );
                  })}
                </div>

                {/* Apply button */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleApply}
                    disabled={applying || applied}
                    className="px-6 py-2.5 rounded-xl text-sm font-medium text-white disabled:opacity-60 transition-all"
                    style={{ background: applied ? '#16a34a' : '#1a73e8' }}
                    onMouseEnter={e => { if (!applied) e.currentTarget.style.background = 'var(--gc-blue-hover)'; }}
                    onMouseLeave={e => { if (!applied) e.currentTarget.style.background = '#1a73e8'; }}
                  >
                    {applying ? 'Applying…' : applied ? 'Applied ✓' : `Apply ${matchedCount} match${matchedCount !== 1 ? 'es' : ''}`}
                  </button>
                  <button
                    onClick={() => setShowMatcher(false)}
                    className="text-sm transition-colors px-3 py-2 rounded-xl"
                    style={{ color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card Layout Panel ────────────────────────────────────────────────────────

function CardLayoutPanel() {
  const { cardFields, setCardFields } = useCalendarStore();
  const [dragKey, setDragKey] = useState<CardFieldKey | null>(null);
  const [overKey, setOverKey] = useState<CardFieldKey | null>(null);

  const available = CARD_FIELD_DEFS.filter(d => !cardFields.includes(d.key));

  const handleDragStart = (key: CardFieldKey) => setDragKey(key);
  const handleDragOver  = (e: React.DragEvent, key: CardFieldKey) => { e.preventDefault(); setOverKey(key); };
  const handleDrop      = (targetKey: CardFieldKey) => {
    if (!dragKey || dragKey === targetKey) { setDragKey(null); setOverKey(null); return; }
    const next = [...cardFields];
    const from = next.indexOf(dragKey);
    const to   = next.indexOf(targetKey);
    next.splice(from, 1);
    next.splice(to, 0, dragKey);
    setCardFields(next);
    setDragKey(null); setOverKey(null);
  };
  const handleDragEnd   = () => { setDragKey(null); setOverKey(null); };

  const remove = (key: CardFieldKey) => setCardFields(cardFields.filter(k => k !== key));
  const add    = (key: CardFieldKey) => setCardFields([...cardFields, key]);

  return (
    <div style={{ maxWidth: 560 }}>
      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Card Layout</h2>
      <p className="text-sm mb-6" style={{ color: 'var(--gc-text-3)' }}>
        Choose which fields appear on event cards in the day view. Drag to reorder. Title is always shown.
      </p>

      {/* Active fields */}
      <div className="rounded-2xl overflow-hidden mb-4" style={{ border: '1px solid var(--gc-border-light)', boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
        {/* Locked title row */}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <GripVertical size={15} style={{ color: 'transparent' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>Title</span>
          <span className="ml-auto text-[11px] px-2 py-0.5 rounded-lg font-medium" style={{ background: 'var(--gc-blue-light)', color: 'var(--gc-blue-text)' }}>Always on</span>
        </div>

        {cardFields.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--gc-text-3)' }}>
            No fields added — add some below.
          </div>
        ) : (
          cardFields.map((key) => {
            const def = CARD_FIELD_DEFS.find(d => d.key === key)!;
            const isOver = overKey === key;
            return (
              <div
                key={key}
                draggable
                onDragStart={() => handleDragStart(key)}
                onDragOver={e => handleDragOver(e, key)}
                onDrop={() => handleDrop(key)}
                onDragEnd={handleDragEnd}
                className="flex items-center gap-3 px-4 py-3"
                style={{
                  borderBottom: '1px solid var(--gc-border-light)',
                  background: isOver ? 'var(--gc-blue-light)' : 'var(--gc-surface)',
                  cursor: 'grab',
                  transition: 'background 100ms',
                }}
              >
                <GripVertical size={15} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                <span className="text-sm font-medium flex-1" style={{ color: 'var(--gc-text-1)' }}>{def.label}</span>
                <button
                  onClick={() => remove(key)}
                  className="rounded-full p-1 transition-colors"
                  style={{ color: 'var(--gc-text-3)' }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover-strong)'; e.currentTarget.style.color = 'var(--gc-red)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}
                >
                  <X size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Available to add */}
      {available.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gc-text-3)' }}>
            Add field
          </div>
          <div className="flex flex-wrap gap-2">
            {available.map(def => (
              <button
                key={def.key}
                onClick={() => add(def.key)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-2)' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-blue-light)'; e.currentTarget.style.color = 'var(--gc-blue-text)'; e.currentTarget.style.borderColor = 'var(--gc-blue)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-surface)'; e.currentTarget.style.color = 'var(--gc-text-2)'; e.currentTarget.style.borderColor = 'var(--gc-border)'; }}
              >
                <Plus size={12} />
                {def.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Nav ──────────────────────────────────────────────────────────────────────

// ─── Saved Locations ─────────────────────────────────────────────────────────

type AcSuggestion = { place_id: string; description: string };

interface LocationFormState {
  name: string;
  address: string;
  lat?: number;
  lng?: number;
  timezone?: string;
}

function LocationForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: LocationFormState;
  onSave: (v: LocationFormState) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [address, setAddress] = useState(initial?.address ?? '');
  const [lat, setLat] = useState<number | undefined>(initial?.lat);
  const [lng, setLng] = useState<number | undefined>(initial?.lng);
  const [timezone, setTimezone] = useState<string | undefined>(initial?.timezone);
  const [geocoded, setGeocoded] = useState(!!initial?.lat);
  const [suggestions, setSuggestions] = useState<AcSuggestion[]>([]);
  const acTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const justPicked = useRef(false);

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 8, padding: '8px 12px',
    fontSize: 14, color: 'var(--gc-text-1)', background: 'var(--gc-surface)',
    outline: 'none', width: '100%',
  };

  function fetchSuggestions(input: string) {
    if (acTimer.current) clearTimeout(acTimer.current);
    if (!input.trim() || input.length < 4) { setSuggestions([]); return; }
    acTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?input=${encodeURIComponent(input)}`);
        const data = await res.json() as { suggestions: AcSuggestion[] };
        setSuggestions(data.suggestions ?? []);
      } catch { setSuggestions([]); }
    }, 300);
  }

  async function pickSuggestion(s: AcSuggestion) {
    justPicked.current = true;
    setSuggestions([]);
    setAddress(s.description);
    try {
      const res  = await fetch(`/api/places?place_id=${encodeURIComponent(s.place_id)}`);
      const data = await res.json() as { result: { lat: number; lng: number; timezone?: string; address?: string } | null };
      if (data.result) {
        setAddress(data.result.address ?? s.description);
        setLat(data.result.lat);
        setLng(data.result.lng);
        setTimezone(data.result.timezone);
        setGeocoded(true);
      }
    } catch { /* ignore */ }
  }

  const canSave = name.trim() && geocoded;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>Location Name</div>
        <input
          value={name} onChange={e => setName(e.target.value)}
          placeholder='e.g. "Main Yard" or "KC Terminal"'
          style={inp}
          autoFocus
        />
      </div>
      <div>
        <div className="text-xs font-semibold mb-1" style={{ color: 'var(--gc-text-3)' }}>Address</div>
        <div style={{ position: 'relative' }}>
          <input
            value={address}
            onChange={e => { setAddress(e.target.value); setGeocoded(false); fetchSuggestions(e.target.value); }}
            onBlur={() => { setTimeout(() => { if (!justPicked.current) setSuggestions([]); justPicked.current = false; }, 150); }}
            placeholder="Search address…"
            style={{ ...inp, paddingRight: geocoded ? 32 : 12 }}
          />
          {geocoded && (
            <Check size={14} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#16a34a' }} />
          )}
          {suggestions.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
              background: 'var(--gc-surface)', border: '1px solid var(--gc-border)',
              borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', marginTop: 2, overflow: 'hidden',
            }}>
              {suggestions.map(s => (
                <button
                  key={s.place_id}
                  type="button"
                  onMouseDown={() => pickSuggestion(s)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                    padding: '8px 12px', fontSize: 13, color: 'var(--gc-text-1)',
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    borderBottom: '1px solid var(--gc-border-light)',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <MapPin size={11} style={{ color: 'var(--gc-text-3)', flexShrink: 0 }} />
                  {s.description}
                </button>
              ))}
            </div>
          )}
        </div>
        {geocoded && lat != null && (
          <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>
            {lat.toFixed(5)}, {lng?.toFixed(5)}{timezone ? ` · ${timezone}` : ''}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" onClick={onCancel}
          style={{ padding: '7px 16px', borderRadius: 8, border: '1px solid var(--gc-border)', background: 'transparent', fontSize: 13, color: 'var(--gc-text-2)', cursor: 'pointer' }}>
          Cancel
        </button>
        <button type="button" onClick={() => onSave({ name: name.trim(), address, lat, lng, timezone })} disabled={!canSave}
          style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: canSave ? '#1a73e8' : 'var(--gc-border)', color: canSave ? '#fff' : 'var(--gc-text-3)', fontSize: 13, fontWeight: 700, cursor: canSave ? 'pointer' : 'default' }}>
          Save
        </button>
      </div>
    </div>
  );
}

function SavedLocationsPanel() {
  const { savedLocations, fetchSavedLocations, addSavedLocation, updateSavedLocation, removeSavedLocation } = useCalendarStore();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => { void fetchSavedLocations(); }, [fetchSavedLocations]);

  return (
    <div style={{ maxWidth: 600 }}>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold" style={{ color: 'var(--gc-text-1)' }}>Saved Locations</h2>
        {!adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 text-sm font-semibold px-3 py-1.5 rounded-lg"
            style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            <Plus size={14} /> Add Location
          </button>
        )}
      </div>
      <p className="text-sm mb-6" style={{ color: 'var(--gc-text-3)' }}>
        Save yards and terminals here to quickly select them as relay points on loads.
      </p>

      {adding && (
        <div style={{ border: '1px solid var(--gc-border)', borderRadius: 12, padding: 16, marginBottom: 12, background: 'var(--gc-surface)' }}>
          <div className="text-sm font-semibold mb-3" style={{ color: 'var(--gc-text-1)' }}>New Location</div>
          <LocationForm
            onSave={async (v) => { await addSavedLocation(v); setAdding(false); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {savedLocations.length === 0 && !adding ? (
        <div style={{ border: '1px dashed var(--gc-border)', borderRadius: 12, padding: 32, textAlign: 'center' }}>
          <MapPin size={24} style={{ color: 'var(--gc-text-3)', margin: '0 auto 8px' }} />
          <div className="text-sm font-medium" style={{ color: 'var(--gc-text-2)' }}>No saved locations yet</div>
          <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>Add your yards and terminals to use them as relay points.</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {savedLocations.map(loc => (
            <div key={loc.id} style={{ border: '1px solid var(--gc-border-light)', borderRadius: 12, background: 'var(--gc-surface)', overflow: 'hidden' }}>
              {editingId === loc.id ? (
                <div style={{ padding: 16 }}>
                  <div className="text-sm font-semibold mb-3" style={{ color: 'var(--gc-text-1)' }}>Edit Location</div>
                  <LocationForm
                    initial={{ name: loc.name, address: loc.address ?? '', lat: loc.lat, lng: loc.lng, timezone: loc.timezone }}
                    onSave={async (v) => { await updateSavedLocation(loc.id, v); setEditingId(null); }}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              ) : confirmDeleteId === loc.id ? (
                <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <span className="text-sm" style={{ color: 'var(--gc-text-1)' }}>Delete <strong>{loc.name}</strong>?</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={() => setConfirmDeleteId(null)}
                      style={{ padding: '5px 14px', borderRadius: 7, border: '1px solid var(--gc-border)', background: 'transparent', fontSize: 13, cursor: 'pointer', color: 'var(--gc-text-2)' }}>
                      Cancel
                    </button>
                    <button type="button" onClick={async () => { await removeSavedLocation(loc.id); setConfirmDeleteId(null); }}
                      style={{ padding: '5px 14px', borderRadius: 7, border: 'none', background: '#d93025', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 10, background: '#e8f0fe', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <MapPin size={16} style={{ color: '#1a73e8' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--gc-text-1)' }}>{loc.name}</div>
                    {loc.address && <div className="text-xs truncate mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{loc.address}</div>}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                    <button type="button" onClick={() => setEditingId(loc.id)}
                      style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                      <Pencil size={14} />
                    </button>
                    <button type="button" onClick={() => setConfirmDeleteId(loc.id)}
                      style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = '#d93025'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Trailers Panel ───────────────────────────────────────────────────────────

const TRAILER_CATEGORIES = ['Swing', 'Roll Up', 'Flat Bed', 'Other'] as const;

function TrailersPanel() {
  const { trailers, fetchTrailers, addTrailer, updateTrailer, removeTrailer, orgId } = useCalendarStore();
  const [adding, setAdding] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [newName, setNewName] = useState('');
  const [newNumber, setNewNumber] = useState('');
  const [newCategory, setNewCategory] = useState<'Swing' | 'Roll Up' | 'Flat Bed' | 'Other'>('Swing');
  const [newNotes, setNewNotes] = useState('');
  const [newMotive, setNewMotive] = useState('');
  const [saving, setSaving] = useState(false);

  const [editId, setEditId] = useState<number | null>(null);
  const [editName, setEditName] = useState('');
  const [editNumber, setEditNumber] = useState('');
  const [editCategory, setEditCategory] = useState<'Swing' | 'Roll Up' | 'Flat Bed' | 'Other'>('Swing');
  const [editNotes, setEditNotes] = useState('');
  const [editMotive, setEditMotive] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  useEffect(() => { if (orgId) void fetchTrailers(); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 8, padding: '7px 10px',
    fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', width: '100%',
  };
  const sel: React.CSSProperties = { ...inp, cursor: 'pointer' };

  function defaultName(number: string, category: string) {
    return number.trim() ? `${number.trim()} - ${category}` : '';
  }

  async function handleAdd() {
    const name = newName.trim() || defaultName(newNumber, newCategory);
    if (!name) return;
    if (!orgId) { setSaveError('Not connected — reload the page and try again.'); return; }
    setSaving(true); setSaveError('');
    try {
      await addTrailer({ name, trailerNumber: newNumber.trim() || undefined, category: newCategory, notes: newNotes.trim() || undefined, motiveVehicleId: newMotive.trim() || undefined });
      setNewName(''); setNewNumber(''); setNewCategory('Swing'); setNewNotes(''); setNewMotive('');
      setAdding(false);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave(id: number) {
    const name = editName.trim() || defaultName(editNumber, editCategory);
    if (!name) return;
    setSaving(true);
    await updateTrailer(id, { name, trailerNumber: editNumber.trim() || undefined, category: editCategory, notes: editNotes.trim() || undefined, motiveVehicleId: editMotive.trim() || undefined });
    setEditId(null); setSaving(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Trailers</div>
        <div className="text-sm" style={{ color: 'var(--gc-text-3)' }}>
          Maintain your trailer list. Link a trailer to a load when creating or editing.
        </div>
      </div>

      {saveError && (
        <div className="text-sm px-3 py-2 rounded-lg" style={{ background: '#fce8e6', color: '#d93025' }}>
          {saveError}
        </div>
      )}

      <div className="space-y-2">
        {trailers.length === 0 && !adding && (
          <div className="text-sm py-6 text-center rounded-xl" style={{ color: 'var(--gc-text-3)', border: '1px dashed var(--gc-border)' }}>
            No trailers yet. Add one below.
          </div>
        )}
        {trailers.map(t => (
          <div key={t.id} className="rounded-xl p-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            {editId === t.id ? (
              <div className="space-y-2">
                <input value={editName} onChange={e => setEditName(e.target.value)} placeholder="Display name (auto-generated if blank)" style={inp} autoFocus />
                <div className="grid grid-cols-2 gap-2">
                  <input value={editNumber} onChange={e => setEditNumber(e.target.value)} placeholder="Trailer #" style={inp} />
                  <select value={editCategory} onChange={e => setEditCategory(e.target.value as typeof editCategory)} style={sel}>
                    {TRAILER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <input value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Notes (optional)" style={inp} />
                <input value={editMotive} onChange={e => setEditMotive(e.target.value)} placeholder="Motive Vehicle ID (optional)" style={inp} />
                <div className="flex gap-2">
                  <button onClick={() => void handleSave(t.id)} disabled={saving}
                    className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    <Check size={12} /> Save
                  </button>
                  <button onClick={() => setEditId(null)}
                    className="text-xs px-3 py-1.5 rounded-lg" style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{t.name}</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                    {[t.trailerNumber && `#${t.trailerNumber}`, t.category].filter(Boolean).join(' · ')}
                    {t.notes && ` · ${t.notes}`}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => { setEditId(t.id); setEditName(t.name); setEditNumber(t.trailerNumber ?? ''); setEditCategory(t.category); setEditNotes(t.notes ?? ''); setEditMotive(t.motiveVehicleId ?? ''); }}
                    style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                    <Pencil size={14} />
                  </button>
                  {confirmDeleteId === t.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => { void removeTrailer(t.id); setConfirmDeleteId(null); }}
                        style={{ padding: '4px 8px', borderRadius: 7, border: 'none', background: '#d93025', cursor: 'pointer', color: '#fff', fontSize: 12, fontWeight: 700 }}>
                        Delete
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)}
                        style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', fontSize: 12 }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(t.id)}
                      style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = '#d93025'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <div className="rounded-xl p-3 space-y-2" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Display name (auto-generated if blank)" style={inp} autoFocus />
            <div className="grid grid-cols-2 gap-2">
              <input value={newNumber} onChange={e => setNewNumber(e.target.value)} placeholder="Trailer #" style={inp} />
              <select value={newCategory} onChange={e => setNewCategory(e.target.value as typeof newCategory)} style={sel}>
                {TRAILER_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <input value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Notes (optional)" style={inp} />
            <input value={newMotive} onChange={e => setNewMotive(e.target.value)} placeholder="Motive Vehicle ID (optional)" style={inp} />
            <div className="flex gap-2">
              <button onClick={() => void handleAdd()} disabled={saving || (!newName.trim() && !newNumber.trim())}
                className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer', opacity: (newName.trim() || newNumber.trim()) ? 1 : 0.5 }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Add
              </button>
              <button onClick={() => { setAdding(false); setNewName(''); setNewNumber(''); setNewCategory('Swing'); setNewNotes(''); setNewMotive(''); }}
                className="text-xs px-3 py-1.5 rounded-lg" style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-2 w-full text-sm font-medium py-2.5 rounded-xl transition-colors"
            style={{ border: '1px dashed var(--gc-border)', background: 'transparent', color: 'var(--gc-text-3)', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#1a73e8'; e.currentTarget.style.color = '#1a73e8'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gc-border)'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
            <Plus size={15} /> Add trailer
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Dispatchers Panel ────────────────────────────────────────────────────────

function DispatchersPanel() {
  const { dispatchers, addDispatcher, updateDispatcher, removeDispatcher } = useCalendarStore();
  const [newName, setNewName] = useState('');
  const [newDefault, setNewDefault] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDefault, setEditDefault] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 8, padding: '7px 10px',
    fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', width: '100%',
  };

  async function handleAdd() {
    if (!newName.trim()) return;
    setSaving(true);
    await addDispatcher(newName.trim(), newDefault);
    setNewName(''); setNewDefault(false); setAdding(false); setSaving(false);
  }

  async function handleSave(id: string) {
    if (!editName.trim()) return;
    setSaving(true);
    await updateDispatcher(id, { name: editName.trim(), isDefault: editDefault });
    setEditId(null); setSaving(false);
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Dispatchers</div>
        <div className="text-sm" style={{ color: 'var(--gc-text-3)' }}>
          Dispatchers linked to your org. The default is auto-filled on new loads.
        </div>
      </div>

      {/* List */}
      <div className="space-y-2">
        {dispatchers.length === 0 && !adding && (
          <div className="text-sm py-6 text-center rounded-xl" style={{ color: 'var(--gc-text-3)', border: '1px dashed var(--gc-border)' }}>
            No dispatchers yet. Add one below.
          </div>
        )}
        {dispatchers.map(d => (
          <div key={d.id} className="rounded-xl p-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            {editId === d.id ? (
              <div className="space-y-2">
                <input value={editName} onChange={e => setEditName(e.target.value)} style={inp}
                  onKeyDown={e => { if (e.key === 'Enter') void handleSave(d.id); if (e.key === 'Escape') setEditId(null); }} autoFocus />
                <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
                  <input type="checkbox" checked={editDefault} onChange={e => setEditDefault(e.target.checked)} />
                  Set as default
                </label>
                <div className="flex gap-2">
                  <button onClick={() => void handleSave(d.id)} disabled={saving}
                    className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    <Check size={12} /> Save
                  </button>
                  <button onClick={() => setEditId(null)}
                    className="text-xs px-3 py-1.5 rounded-lg" style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium" style={{ color: 'var(--gc-text-1)' }}>{d.name}</span>
                  {d.isDefault && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-lg" style={{ background: '#dbeafe', color: '#1d4ed8' }}>Default</span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => { setEditId(d.id); setEditName(d.name); setEditDefault(d.isDefault); }}
                    style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                    <Pencil size={14} />
                  </button>
                  {confirmDeleteId === d.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => { void removeDispatcher(d.id); setConfirmDeleteId(null); }}
                        style={{ padding: '4px 8px', borderRadius: 7, border: 'none', background: '#d93025', cursor: 'pointer', color: '#fff', fontSize: 12, fontWeight: 700 }}>
                        Delete
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)}
                        style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', fontSize: 12 }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(d.id)}
                      style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = '#d93025'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add form */}
        {adding ? (
          <div className="rounded-xl p-3 space-y-2" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Dispatcher name" style={inp}
              onKeyDown={e => { if (e.key === 'Enter') void handleAdd(); if (e.key === 'Escape') setAdding(false); }} autoFocus />
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--gc-text-2)' }}>
              <input type="checkbox" checked={newDefault} onChange={e => setNewDefault(e.target.checked)} />
              Set as default
            </label>
            <div className="flex gap-2">
              <button onClick={() => void handleAdd()} disabled={saving || !newName.trim()}
                className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer', opacity: newName.trim() ? 1 : 0.5 }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Add
              </button>
              <button onClick={() => { setAdding(false); setNewName(''); setNewDefault(false); }}
                className="text-xs px-3 py-1.5 rounded-lg" style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-2 w-full text-sm font-medium py-2.5 rounded-xl transition-colors"
            style={{ border: '1px dashed var(--gc-border)', background: 'transparent', color: 'var(--gc-text-3)', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#1a73e8'; e.currentTarget.style.color = '#1a73e8'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gc-border)'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
            <Plus size={15} /> Add dispatcher
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Customers Panel ──────────────────────────────────────────────────────────

function CustomersPanel() {
  const { customers, addCustomer, updateCustomer, removeCustomer } = useCalendarStore();
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', mcNum: '', contactName: '', contactEmail: '', contactPhone: '', notes: '' });

  const inp: React.CSSProperties = {
    border: '1px solid var(--gc-border)', borderRadius: 8, padding: '6px 10px',
    fontSize: 13, color: 'var(--gc-text-1)', background: 'var(--gc-surface)', outline: 'none', width: '100%',
  };
  const emptyForm = { name: '', mcNum: '', contactName: '', contactEmail: '', contactPhone: '', notes: '' };

  async function handleAdd() {
    if (!form.name.trim()) return;
    setSaving(true);
    await addCustomer({ name: form.name.trim(), aliases: [], mcNum: form.mcNum || undefined, contactName: form.contactName || undefined, contactEmail: form.contactEmail || undefined, contactPhone: form.contactPhone || undefined, notes: form.notes || undefined });
    setForm(emptyForm); setAdding(false); setSaving(false);
  }

  async function handleSave(id: string) {
    if (!form.name.trim()) return;
    setSaving(true);
    await updateCustomer(id, { name: form.name.trim(), mcNum: form.mcNum || undefined, contactName: form.contactName || undefined, contactEmail: form.contactEmail || undefined, contactPhone: form.contactPhone || undefined, notes: form.notes || undefined });
    setEditId(null); setSaving(false);
  }

  function startEdit(c: (typeof customers)[0]) {
    setEditId(c.id);
    setForm({ name: c.name, mcNum: c.mcNum ?? '', contactName: c.contactName ?? '', contactEmail: c.contactEmail ?? '', contactPhone: c.contactPhone ?? '', notes: c.notes ?? '' });
  }

  const FormFields = () => (
    <div className="space-y-2">
      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Customer name *" style={inp} autoFocus />
      <div className="grid grid-cols-2 gap-2">
        <input value={form.mcNum} onChange={e => setForm(f => ({ ...f, mcNum: e.target.value }))} placeholder="MC #" style={inp} />
        <input value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} placeholder="Contact name" style={inp} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} placeholder="Email" style={inp} />
        <input value={form.contactPhone} onChange={e => setForm(f => ({ ...f, contactPhone: e.target.value }))} placeholder="Phone" style={inp} />
      </div>
      <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="Notes" rows={2}
        style={{ ...inp, resize: 'vertical', fontFamily: 'inherit' }} />
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Customers</div>
        <div className="text-sm" style={{ color: 'var(--gc-text-3)' }}>
          When a rate con is parsed, the customer name is matched against this list automatically.
        </div>
      </div>

      <div className="space-y-2">
        {customers.length === 0 && !adding && (
          <div className="text-sm py-6 text-center rounded-xl" style={{ color: 'var(--gc-text-3)', border: '1px dashed var(--gc-border)' }}>
            No customers yet. They&apos;ll be created automatically when you parse rate cons.
          </div>
        )}

        {customers.map(c => (
          <div key={c.id} className="rounded-xl p-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            {editId === c.id ? (
              <div className="space-y-3">
                <FormFields />
                {c.aliases.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--gc-text-3)' }}>
                    Aliases: {c.aliases.join(', ')}
                  </div>
                )}
                <div className="flex gap-2">
                  <button onClick={() => void handleSave(c.id)} disabled={saving}
                    className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: 'pointer' }}>
                    {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
                  </button>
                  <button onClick={() => setEditId(null)}
                    className="text-xs px-3 py-1.5 rounded-lg"
                    style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: 'var(--gc-text-1)' }}>{c.name}</div>
                  {c.mcNum && <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-3)' }}>MC# {c.mcNum}</div>}
                  {c.contactName && <div className="text-xs" style={{ color: 'var(--gc-text-3)' }}>{c.contactName}{c.contactEmail ? ` · ${c.contactEmail}` : ''}{c.contactPhone ? ` · ${c.contactPhone}` : ''}</div>}
                  {c.aliases.length > 0 && (
                    <div className="text-xs mt-1" style={{ color: 'var(--gc-text-3)' }}>
                      Also known as: {c.aliases.join(', ')}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => startEdit(c)}
                    style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-text-1)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                    <Pencil size={14} />
                  </button>
                  {confirmDeleteId === c.id ? (
                    <div className="flex items-center gap-1">
                      <button onClick={() => { void removeCustomer(c.id); setConfirmDeleteId(null); }}
                        style={{ padding: '4px 8px', borderRadius: 7, border: 'none', background: '#d93025', cursor: 'pointer', color: '#fff', fontSize: 12, fontWeight: 700 }}>
                        Delete
                      </button>
                      <button onClick={() => setConfirmDeleteId(null)}
                        style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--gc-border)', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-2)', fontSize: 12 }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmDeleteId(c.id)}
                      style={{ padding: 6, borderRadius: 7, border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--gc-text-3)' }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#fef2f2'; e.currentTarget.style.color = '#d93025'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <div className="rounded-xl p-3 space-y-3" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <FormFields />
            <div className="flex gap-2">
              <button onClick={() => void handleAdd()} disabled={saving || !form.name.trim()}
                className="flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
                style={{ background: '#1a73e8', color: '#fff', border: 'none', cursor: saving || !form.name.trim() ? 'not-allowed' : 'pointer', opacity: form.name.trim() ? 1 : 0.5 }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Add
              </button>
              <button onClick={() => { setAdding(false); setForm(emptyForm); }}
                className="text-xs px-3 py-1.5 rounded-lg"
                style={{ border: '1px solid var(--gc-border)', background: 'transparent', color: 'var(--gc-text-2)', cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)}
            className="flex items-center gap-2 w-full text-sm font-medium py-2.5 rounded-xl transition-colors"
            style={{ border: '1px dashed var(--gc-border)', background: 'transparent', color: 'var(--gc-text-3)', cursor: 'pointer' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#1a73e8'; e.currentTarget.style.color = '#1a73e8'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--gc-border)'; e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
            <Plus size={15} /> Add customer manually
          </button>
        )}
      </div>
    </div>
  );
}

const NAV: { section: string; items: { id: NavItem; label: string; icon: React.ReactNode }[] }[] = [
  {
    section: 'Personal',
    items: [
      { id: 'appearance', label: 'Appearance', icon: <Sun size={15} /> },
      { id: 'timezone',   label: 'Timezone',   icon: <Globe size={15} /> },
    ],
  },
  {
    section: 'Workspace',
    items: [
      { id: 'assets',           label: 'Assets',           icon: <Truck size={15} /> },
      { id: 'trailers',         label: 'Trailers',         icon: <Truck size={15} /> },
      { id: 'dispatchers',      label: 'Dispatchers',      icon: <Users size={15} /> },
      { id: 'customers',        label: 'Customers',        icon: <Truck size={15} /> },
      { id: 'saved-locations',  label: 'Saved Locations',  icon: <MapPin size={15} /> },
      { id: 'load-fields',      label: 'Load Fields',      icon: <LayoutList size={15} /> },
      { id: 'card-layout',      label: 'Card Layout',      icon: <Layers size={15} /> },
      { id: 'ratecon-ai',       label: 'Rate Con AI',      icon: <Bot size={15} /> },
      { id: 'invoicing',        label: 'Invoicing',        icon: <FileText size={15} /> },
      { id: 'integrations',     label: 'Integrations',     icon: <Plug size={15} /> },
      { id: 'driver-app',       label: 'Driver App',       icon: <Smartphone size={15} /> },
    ],
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

function ResetDemoButton() {
  const router = useRouter();
  const exitDemoMode = useCalendarStore(s => s.exitDemoMode);
  const resetOnboarding = useOnboardingStore(s => s.resetOnboarding);
  const [busy, setBusy] = useState(false);

  const handleReset = async () => {
    if (!confirm('Delete all assets, events, and drivers for this org and re-enter demo mode?')) return;
    setBusy(true);
    try {
      const res = await fetch('/api/dev/reset-org', { method: 'DELETE' });
      if (!res.ok) { alert('Reset failed'); setBusy(false); return; }
      exitDemoMode();
      resetOnboarding();
      // Full reload so DataLoader re-runs from scratch
      window.location.href = '/calendar';
    } catch {
      alert('Reset failed');
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleReset}
      disabled={busy}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
      style={{ color: 'var(--gc-red)', background: 'transparent' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
      Reset to Demo Mode
    </button>
  );
}

export default function SettingsPage() {
  const [active, setActive] = useState<NavItem>('appearance');

  return (
    <div className="flex flex-col" style={{ height: '100vh', background: 'var(--gc-bg)' }}>
      <DataLoader />

      {/* Top bar */}
      <div className="shrink-0 flex items-center gap-4 px-6" style={{ height: 64, borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <Link href="/calendar" className="p-2 rounded-full transition-colors" style={{ color: 'var(--gc-text-2)' }}
          onMouseEnter={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={(e: React.MouseEvent<HTMLAnchorElement>) => (e.currentTarget.style.background = 'transparent')}>
          <ArrowLeft size={20} />
        </Link>
        <h1 className="text-base font-semibold" style={{ color: 'var(--gc-text-1)' }}>Settings</h1>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">

        {/* Left nav */}
        <nav className="shrink-0 flex flex-col py-4 px-3 overflow-y-auto" style={{ width: 320, borderRight: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
          <div className="flex-1">
            {NAV.map(group => (
              <div key={group.section} className="mb-4">
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
                  {group.section}
                </div>
                {group.items.map(item => {
                  const isActive = active === item.id;
                  return (
                    <button key={item.id} onClick={() => setActive(item.id)}
                      className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
                      style={{ color: isActive ? '#1a73e8' : 'var(--gc-text-2)', background: isActive ? '#e8f0fe' : 'transparent' }}
                      onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                      onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}>
                      {item.icon}
                      {item.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Dev tools */}
          <div style={{ borderTop: '1px solid var(--gc-border)', paddingTop: 12, marginTop: 8 }}>
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
              Developer
            </div>
            <ResetDemoButton />
          </div>
        </nav>

        {/* Main content — scrollable */}
        <main className="flex-1 overflow-y-auto py-8 px-8">
          {active === 'appearance'   && <AppearancePanel />}
          {active === 'timezone'     && <TimezonePanel />}
          {active === 'assets'       && <AssetsPanel />}
          {active === 'load-fields'  && <LoadFieldsPanel />}
          {active === 'card-layout'  && <CardLayoutPanel />}
          {active === 'ratecon-ai'   && <RateConAIPanel setActive={setActive} />}
          {active === 'invoicing'    && <InvoicingPanel />}
          {active === 'integrations'    && <IntegrationsPanel />}
          {active === 'saved-locations' && <SavedLocationsPanel />}
          {active === 'dispatchers'     && <DispatchersPanel />}
          {active === 'customers'       && <CustomersPanel />}
          {active === 'trailers'        && <TrailersPanel />}
          {active === 'driver-app'      && <DriverAppPanel />}
        </main>
      </div>
    </div>
  );
}
