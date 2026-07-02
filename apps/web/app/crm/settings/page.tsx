'use client';

/**
 * /crm/settings — Phase-1 CRM settings: the ICP (ideal customer
 * profile) filters that drive FMCSA census ingest.
 *
 * Same triple gate as /crm. Viewing needs crm.access; EDITS need
 * crm.manage (the API enforces this on PATCH /v1/crm/settings — the
 * UI mirrors it by disabling the form).
 *
 * Email outreach settings (send window, daily cap, identity, talk
 * track) ship in Phase 2 — shown here read-only so the operator knows
 * where they'll live.
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Target, ArrowLeft, Loader2, Mail } from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import RequireCap from '@/components/auth/RequireCap';
import RequireInternalOrg from '@/components/crm/RequireInternalOrg';
import { OPERATION_CLASS_LABELS } from '@/components/crm/crmMeta';
import { usePermissions } from '@/lib/usePermissions';
import { railway, RailwayError } from '@/lib/railway';
import type { CrmSettings } from '@fleetcal/types';

const OPERATION_CLASSES = ['A', 'B', 'C'] as const;

export default function CrmSettingsPage() {
  return (
    <RequireCap cap="crm.access" module="crm">
      <RequireInternalOrg>
        <CrmSettingsPageInner />
      </RequireInternalOrg>
    </RequireCap>
  );
}

function CrmSettingsPageInner() {
  const { can } = usePermissions();
  const canManage = can('crm.manage');

  const [settings, setSettings] = useState<CrmSettings | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState<string | null>(null);

  // ── ICP form state (strings for the number inputs so partially
  //    typed values don't fight the cursor) ──────────────────────────
  const [puMin,  setPuMin]  = useState('');
  const [puMax,  setPuMax]  = useState('');
  const [states, setStates] = useState('');
  const [opClasses, setOpClasses] = useState<Set<'A' | 'B' | 'C'>>(new Set());
  const [localOnly, setLocalOnly] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { settings: s } = await railway.crmGetSettings();
        if (cancelled) return;
        setSettings(s);
        setPuMin(String(s.icp.powerUnitsMin));
        setPuMax(String(s.icp.powerUnitsMax));
        setStates(s.icp.states.join(', '));
        setOpClasses(new Set(s.icp.operationClasses));
        setLocalOnly(s.icp.localOnly);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof RailwayError ? `Failed to load settings (${e.status})` : 'Failed to load settings.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function toggleOpClass(c: 'A' | 'B' | 'C') {
    setOpClasses(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });
  }

  async function handleSave() {
    if (!settings || saving || !canManage) return;
    const min = Number(puMin);
    const max = Number(puMax);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
      setSaveMsg('Power-units range is invalid (min ≤ max, both ≥ 0).');
      return;
    }
    const parsedStates = states
      .split(/[,\s]+/)
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z]{2}$/.test(s));
    // Keep the declared A/B/C order stable regardless of click order.
    const classes = OPERATION_CLASSES.filter(c => opClasses.has(c));
    setSaving(true);
    setSaveMsg(null);
    try {
      const { settings: next } = await railway.crmPatchSettings({
        icp: {
          powerUnitsMin: min,
          powerUnitsMax: max,
          states: parsedStates,
          operationClasses: classes,
          localOnly,
        },
      });
      setSettings(next);
      setStates(next.icp.states.join(', '));
      setSaveMsg('Saved.');
    } catch (e) {
      setSaveMsg(e instanceof RailwayError ? `Save failed (${e.status})` : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--gc-bg)',
    border:     '1px solid var(--gc-border-light)',
    color:      'var(--gc-text-1)',
  };

  return (
    <AppShell title="CRM settings" icon={Target}>
      <div className="px-6 py-5 max-w-[720px] flex flex-col gap-4">
        <Link href="/crm"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-medium self-start"
          style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
          <ArrowLeft size={13} /> Back to leads
        </Link>

        {loading ? (
          <div className="flex items-center justify-center py-16" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : error ? (
          <div className="rounded-xl p-4 text-sm" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
            {error}
          </div>
        ) : settings && (
          <>
            {!canManage && (
              <div className="rounded-xl px-4 py-3 text-[12.5px]"
                style={{ background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a' }}>
                You can view CRM settings but editing requires the <code>crm.manage</code> capability.
              </div>
            )}

            {/* ICP filters */}
            <section className="rounded-2xl px-5 py-4 flex flex-col gap-4"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
              <div>
                <h2 className="text-[14px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  ICP filters
                </h2>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Which FMCSA census carriers get ingested as leads. Applied at sync time.
                </p>
              </div>

              {/* Power units */}
              <div className="flex items-center gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                  Power units
                </label>
                <input type="number" min={0} value={puMin} disabled={!canManage}
                  onChange={e => setPuMin(e.target.value)}
                  className="w-24 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                  style={inputStyle} />
                <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>to</span>
                <input type="number" min={0} value={puMax} disabled={!canManage}
                  onChange={e => setPuMax(e.target.value)}
                  className="w-24 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                  style={inputStyle} />
              </div>

              {/* States */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  States
                </label>
                <div className="flex-1 min-w-0">
                  <input type="text" value={states} disabled={!canManage}
                    onChange={e => setStates(e.target.value)}
                    placeholder="e.g. UT, ID, WY — empty = all US"
                    className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none uppercase disabled:opacity-60"
                    style={inputStyle} />
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Comma-separated two-letter codes. Leave empty to ingest every state.
                  </div>
                </div>
              </div>

              {/* Operation classes */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  Operation classes
                </label>
                <div className="flex flex-col gap-1.5">
                  {OPERATION_CLASSES.map(c => (
                    <label key={c} className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none"
                      style={{ color: 'var(--gc-text-1)', opacity: canManage ? 1 : 0.6 }}>
                      <input type="checkbox"
                        checked={opClasses.has(c)}
                        disabled={!canManage}
                        onChange={() => toggleOpClass(c)}
                        style={{ accentColor: '#1a73e8' }} />
                      <span className="font-semibold">{c}</span>
                      <span style={{ color: 'var(--gc-text-3)' }}>— {OPERATION_CLASS_LABELS[c]}</span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Local only */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  Local only
                </label>
                <div className="flex-1 min-w-0">
                  <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none"
                    style={{ color: 'var(--gc-text-1)', opacity: canManage ? 1 : 0.6 }}>
                    <input type="checkbox"
                      checked={localOnly}
                      disabled={!canManage}
                      onChange={e => setLocalOnly(e.target.checked)}
                      style={{ accentColor: '#1a73e8' }} />
                    Only target local carriers
                  </label>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Soft filter: carriers that fail the local check (some within-100-mile drivers,
                    zero beyond-100) are still ingested but auto-stamped <strong>disqualified</strong> —
                    never dropped — so they stay searchable and can be re-qualified by hand.
                  </div>
                </div>
              </div>

              {/* Save */}
              <div className="flex items-center justify-end gap-3 pt-1"
                style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 12 }}>
                {saveMsg && (
                  <span className="text-[12px] font-semibold"
                    style={{ color: saveMsg === 'Saved.' ? '#188038' : '#c5221f' }}>
                    {saveMsg}
                  </span>
                )}
                <button onClick={() => void handleSave()} disabled={!canManage || saving}
                  className="text-[12.5px] font-semibold px-4 py-2 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  {saving ? 'Saving…' : 'Save ICP filters'}
                </button>
              </div>
            </section>

            {/* Phase-2 placeholder — email outreach settings */}
            <section className="rounded-2xl px-5 py-4"
              style={{ background: 'var(--gc-surface)', border: '1px dashed var(--gc-border)' }}>
              <div className="flex items-center gap-2 mb-1">
                <Mail size={14} style={{ color: 'var(--gc-text-3)' }} />
                <h2 className="text-[14px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                  Email outreach
                </h2>
                <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold"
                  style={{ background: '#f3e8fd', color: '#7b1fa2' }}>
                  Phase 2
                </span>
              </div>
              <p className="text-[12px] mb-3" style={{ color: 'var(--gc-text-3)' }}>
                Send window, daily cap, sender identity, and the call-queue talk track arrive with
                outreach sequences in Phase 2. Current stored values (read-only):
              </p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12.5px]">
                <ReadOnlyFact label="Daily send cap" value={String(settings.dailySendCap)} />
                <ReadOnlyFact label="Send window"
                  value={`${settings.sendWindow.startHour}:00–${settings.sendWindow.endHour}:00 ${settings.sendWindow.timezone}${settings.sendWindow.weekdaysOnly ? ' · weekdays' : ''}`} />
                <ReadOnlyFact label="Auto-send" value={settings.autoSend ? 'On' : 'Off (approval batch)'} />
                <ReadOnlyFact label="From name" value={settings.fromName || '—'} />
                <ReadOnlyFact label="Reply-to" value={settings.replyTo || '—'} />
                <ReadOnlyFact label="CAN-SPAM footer" value={settings.physicalAddressFooter ? 'Set' : 'Not set (sends refuse)'} />
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}

function ReadOnlyFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10.5px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="font-medium" style={{ color: 'var(--gc-text-2)' }}>{value}</div>
    </div>
  );
}
