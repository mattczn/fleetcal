'use client';

/**
 * /crm/settings — Phase-1 CRM settings: the ICP (ideal customer
 * profile) filters that drive FMCSA census ingest.
 *
 * Same triple gate as /crm. Viewing needs crm.access; EDITS need
 * crm.manage (the API enforces this on PATCH /v1/crm/settings — the
 * UI mirrors it by disabling the form).
 *
 * Phase 2 added the email-outreach card: daily send cap, send window,
 * auto-send, sender identity, and the CAN-SPAM physical-address footer
 * (sends REFUSE while it's empty — enforced in the send sweep).
 */

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { Target, ArrowLeft, Loader2, Mail } from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import RequireCap from '@/components/auth/RequireCap';
import RequireInternalOrg from '@/components/crm/RequireInternalOrg';
import { OPERATION_CLASS_LABELS } from '@/components/crm/crmMeta';
import { StyledSelect } from '@/components/ui/StyledSelect';
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
  const [forHireOnly, setForHireOnly] = useState(true);
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [mcs150Months, setMcs150Months] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [rescanMsg, setRescanMsg] = useState<string | null>(null);
  const [excludeKeywords, setExcludeKeywords] = useState('');
  const [cleaningUp, setCleaningUp] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  // ── Outreach form state (Phase 2) ──────────────────────────────────
  const [dailyCap,     setDailyCap]     = useState('');
  const [startHour,    setStartHour]    = useState('9');
  const [endHour,      setEndHour]      = useState('17');
  const [timezone,     setTimezone]     = useState('America/Denver');
  const [weekdaysOnly, setWeekdaysOnly] = useState(true);
  const [autoSend,     setAutoSend]     = useState(false);
  const [fromName,     setFromName]     = useState('');
  const [replyTo,      setReplyTo]      = useState('');
  const [addressFooter, setAddressFooter] = useState('');
  const [introSubject, setIntroSubject] = useState('');
  const [introBody,    setIntroBody]    = useState('');
  const [outreachSaving, setOutreachSaving] = useState(false);
  const [outreachMsg,    setOutreachMsg]    = useState<string | null>(null);

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
        setForHireOnly(s.icp.forHireOnly !== false);
        setExcludeKeywords((s.icp.nameExcludeKeywords ?? []).join(', '));
        setAgeMin(String(s.icp.establishedYearsMin ?? 1));
        setAgeMax(String(s.icp.establishedYearsMax ?? 15));
        setMcs150Months(String(s.icp.mcs150SinceMonths ?? 24));
        setDailyCap(String(s.dailySendCap));
        setStartHour(String(s.sendWindow.startHour));
        setEndHour(String(s.sendWindow.endHour));
        setTimezone(s.sendWindow.timezone || 'America/Denver');
        setWeekdaysOnly(s.sendWindow.weekdaysOnly);
        setAutoSend(s.autoSend);
        setFromName(s.fromName);
        setReplyTo(s.replyTo);
        setAddressFooter(s.physicalAddressFooter);
        setIntroSubject(s.introSubject);
        setIntroBody(s.introBody);
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
          forHireOnly,
          nameExcludeKeywords: excludeKeywords
            .split(',').map(k => k.trim()).filter(Boolean),
          establishedYearsMin: Math.max(0, Number(ageMin) || 1),
          establishedYearsMax: Math.max(1, Number(ageMax) || 15),
          mcs150SinceMonths:   Math.max(1, Number(mcs150Months) || 24),
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

  async function handleSaveOutreach() {
    if (!settings || outreachSaving || !canManage) return;
    const cap = Number(dailyCap);
    if (!Number.isFinite(cap) || cap < 1) {
      setOutreachMsg('Daily send cap must be at least 1.');
      return;
    }
    const start = Number(startHour);
    const end   = Number(endHour);
    if (start >= end) {
      setOutreachMsg('Send window start must be before end.');
      return;
    }
    if (!timezone.trim()) {
      setOutreachMsg('Timezone is required (IANA, e.g. America/Denver).');
      return;
    }
    setOutreachSaving(true);
    setOutreachMsg(null);
    try {
      const { settings: next } = await railway.crmPatchSettings({
        dailySendCap: cap,
        sendWindow: {
          startHour: start,
          endHour:   end,
          timezone:  timezone.trim(),
          weekdaysOnly,
        },
        autoSend,
        fromName: fromName.trim(),
        replyTo:  replyTo.trim(),
        physicalAddressFooter: addressFooter.trim(),
        introSubject: introSubject.trim(),
        introBody,
      });
      setSettings(next);
      setOutreachMsg('Saved.');
    } catch (e) {
      setOutreachMsg(e instanceof RailwayError ? `Save failed (${e.status})` : 'Save failed.');
    } finally {
      setOutreachSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--gc-bg)',
    border:     '1px solid var(--gc-border-light)',
    color:      'var(--gc-text-1)',
  };

  const hourSelectStyle: React.CSSProperties = {
    ...inputStyle, borderRadius: 8, padding: '7px 10px', fontSize: 13,
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

              {/* Established age range — filters out paperwork-only new
                  registrations AND ancient carriers with entrenched software. */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Established
                </label>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <input type="number" min={0} value={ageMin} disabled={!canManage}
                      onChange={e => setAgeMin(e.target.value)}
                      className="w-20 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                      style={inputStyle} />
                    <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>to</span>
                    <input type="number" min={1} value={ageMax} disabled={!canManage}
                      onChange={e => setAgeMax(e.target.value)}
                      className="w-20 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                      style={inputStyle} />
                    <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>years since FMCSA registration</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Drops carriers younger than the min (paperwork-only, no revenue) and older than the
                    max (usually locked into legacy software). Default 1–15.
                  </div>
                </div>
              </div>

              {/* MCS-150 recency — proves the carrier is actively operating. */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  MCS-150 filed in
                </label>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>the last</span>
                    <input type="number" min={1} value={mcs150Months} disabled={!canManage}
                      onChange={e => setMcs150Months(e.target.value)}
                      className="w-20 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                      style={inputStyle} />
                    <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>months</span>
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Filters out zombie carriers — DOTs on the books but not actively hauling.
                    Default 24 months (one biennial update cycle).
                  </div>
                </div>
              </div>

              {/* For-hire only — private fleets don't buy dispatch software. */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  For-hire only
                </label>
                <div className="flex-1 min-w-0">
                  <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none"
                    style={{ color: 'var(--gc-text-1)', opacity: canManage ? 1 : 0.6 }}>
                    <input type="checkbox"
                      checked={forHireOnly}
                      disabled={!canManage}
                      onChange={e => setForHireOnly(e.target.checked)}
                      style={{ accentColor: '#1a73e8' }} />
                    Only ingest carriers with authorized-for-hire status
                  </label>
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Drops private fleets (Nestle, landscapers). Recommended on — private fleets don't
                    buy dispatch software.
                  </div>
                </div>
              </div>

              {/* Industry name-keyword blacklist */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Exclude keywords
                </label>
                <div className="flex-1 min-w-0">
                  <textarea rows={3} value={excludeKeywords} disabled={!canManage}
                    onChange={e => setExcludeKeywords(e.target.value)}
                    placeholder="TOWING, AVIATION, CONSTRUCTION, LANDSCAPING, DUMPSTER, LIMO, REPAIR, PUMPING"
                    className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none resize-y disabled:opacity-60"
                    style={inputStyle} />
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Comma-separated. Case-insensitive substring match against legal + DBA name. Applied
                    at sync AND retroactively via the button below. Any lead whose name contains any of
                    these gets ingested as (or moved to) <strong>disqualified</strong> — never dropped
                    outright, so you can spot-check if a filter's too aggressive.
                  </div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap">
                    <button
                      onClick={async () => {
                        if (!canManage || cleaningUp) return;
                        if (!confirm('Scan existing leads and move any whose name matches your keyword list to Disqualified? Only leads in New/Enriched/Queued get touched — never anything already in outreach.')) return;
                        setCleaningUp(true); setCleanupMsg(null);
                        try {
                          const r = await railway.crmCleanupNonIcp(false);
                          setCleanupMsg(`Scanned ${r.scanned}, matched ${r.matched}, disqualified ${r.disqualified}.`);
                        } catch (e) {
                          setCleanupMsg(e instanceof RailwayError ? `Cleanup failed (${e.status})` : 'Cleanup failed.');
                        } finally { setCleaningUp(false); }
                      }}
                      disabled={!canManage || cleaningUp}
                      className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                      style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}>
                      {cleaningUp ? 'Reclassifying…' : 'Reclassify existing leads →'}
                    </button>
                    {cleanupMsg && (
                      <span className="text-[12px] font-semibold"
                        style={{ color: cleanupMsg.startsWith('Scanned') ? '#188038' : '#c5221f' }}>
                        {cleanupMsg}
                      </span>
                    )}
                  </div>
                </div>
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

              {/* Save + rescan */}
              <div className="flex items-center justify-between gap-3 pt-1 flex-wrap"
                style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 12 }}>
                <button
                  onClick={async () => {
                    if (!canManage || rescanning) return;
                    if (!confirm('Reset the FMCSA cursor to DOT 1 and rescan the whole census with the current ICP? Existing leads are never deleted; new matches will be inserted.')) return;
                    setRescanning(true); setRescanMsg(null);
                    try {
                      const { result } = await railway.crmSync({ fromScratch: true });
                      setRescanMsg(`Ingested +${result.inserted} new leads (${result.duplicates} dup, ${result.disqualified} disqualified, cursor now at DOT ${result.cursorDotNumber ?? '?'}).`);
                    } catch (e) {
                      setRescanMsg(e instanceof RailwayError ? `Rescan failed (${e.status})` : 'Rescan failed.');
                    } finally { setRescanning(false); }
                  }}
                  disabled={!canManage || rescanning}
                  className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}>
                  {rescanning ? 'Rescanning…' : 'Rescan census from scratch'}
                </button>
                <div className="flex items-center gap-3">
                  {(rescanMsg || saveMsg) && (
                    <span className="text-[12px] font-semibold"
                      style={{ color: (saveMsg === 'Saved.' || rescanMsg?.startsWith('Ingested')) ? '#188038' : '#c5221f' }}>
                      {rescanMsg ?? saveMsg}
                    </span>
                  )}
                  <button onClick={() => void handleSave()} disabled={!canManage || saving}
                    className="text-[12.5px] font-semibold px-4 py-2 rounded-lg transition-opacity disabled:opacity-50"
                    style={{ background: '#1a73e8', color: '#fff' }}>
                    {saving ? 'Saving…' : 'Save ICP filters'}
                  </button>
                </div>
              </div>
            </section>

            {/* Email outreach (Phase 2) */}
            <section className="rounded-2xl px-5 py-4 flex flex-col gap-4"
              style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
              <div>
                <div className="flex items-center gap-2">
                  <Mail size={14} style={{ color: 'var(--gc-text-3)' }} />
                  <h2 className="text-[14px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                    Email outreach
                  </h2>
                </div>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                  Deliverability + identity settings for sequence sends. The FROM domain itself
                  comes from the server environment — never fleetcal.app.
                </p>
              </div>

              {/* Daily send cap */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Daily send cap
                </label>
                <div className="flex-1 min-w-0">
                  <input type="number" min={1} value={dailyCap} disabled={!canManage}
                    onChange={e => setDailyCap(e.target.value)}
                    className="w-24 rounded-lg px-2.5 py-1.5 text-[13px] outline-none tabular-nums disabled:opacity-60"
                    style={inputStyle} />
                  <div className="text-[11px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
                    Warm-up: start at 25, ramp to 50 → 100 over ~3 weeks.
                  </div>
                </div>
              </div>

              {/* Send window */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Send window
                </label>
                <div className="flex-1 min-w-0 flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <StyledSelect value={startHour} disabled={!canManage}
                      onChange={e => setStartHour(e.target.value)}
                      style={hourSelectStyle}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={String(h)}>{h}:00</option>
                      ))}
                    </StyledSelect>
                    <span className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>to</span>
                    <StyledSelect value={endHour} disabled={!canManage}
                      onChange={e => setEndHour(e.target.value)}
                      style={hourSelectStyle}>
                      {Array.from({ length: 24 }, (_, h) => (
                        <option key={h} value={String(h)}>{h}:00</option>
                      ))}
                    </StyledSelect>
                    <input type="text" value={timezone} disabled={!canManage}
                      onChange={e => setTimezone(e.target.value)}
                      placeholder="America/Denver"
                      className="w-44 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                      style={inputStyle} />
                  </div>
                  <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none"
                    style={{ color: 'var(--gc-text-1)', opacity: canManage ? 1 : 0.6 }}>
                    <input type="checkbox"
                      checked={weekdaysOnly}
                      disabled={!canManage}
                      onChange={e => setWeekdaysOnly(e.target.checked)}
                      style={{ accentColor: '#1a73e8' }} />
                    Weekdays only
                  </label>
                </div>
              </div>

              {/* Auto-send */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-0.5" style={{ color: 'var(--gc-text-2)' }}>
                  Auto-send
                </label>
                <div className="flex-1 min-w-0">
                  <label className="inline-flex items-center gap-2 text-[13px] cursor-pointer select-none"
                    style={{ color: 'var(--gc-text-1)', opacity: canManage ? 1 : 0.6 }}>
                    <input type="checkbox"
                      checked={autoSend}
                      disabled={!canManage}
                      onChange={e => setAutoSend(e.target.checked)}
                      style={{ accentColor: '#1a73e8' }} />
                    Send automatically without approval
                  </label>
                  <div className="text-[11px] mt-1" style={{ color: autoSend ? '#c5221f' : 'var(--gc-text-3)' }}>
                    {autoSend
                      ? 'Warning: outbox approval is skipped — rendered emails send as soon as the window opens.'
                      : 'Off = approval-batch mode: sends wait in the outbox until approved.'}
                  </div>
                </div>
              </div>

              {/* From name */}
              <div className="flex items-center gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                  From name
                </label>
                <input type="text" value={fromName} disabled={!canManage}
                  onChange={e => setFromName(e.target.value)}
                  placeholder="FleetCal"
                  className="w-64 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                  style={inputStyle} />
              </div>

              {/* Reply-to */}
              <div className="flex items-center gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0" style={{ color: 'var(--gc-text-2)' }}>
                  Reply-to
                </label>
                <input type="email" value={replyTo} disabled={!canManage}
                  onChange={e => setReplyTo(e.target.value)}
                  placeholder="you@example.com"
                  className="w-64 rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                  style={inputStyle} />
              </div>

              {/* Physical address footer */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Physical address
                </label>
                <div className="flex-1 min-w-0">
                  <textarea rows={3} value={addressFooter} disabled={!canManage}
                    onChange={e => setAddressFooter(e.target.value)}
                    placeholder={'Systematica LLC\n123 Main St\nOgden, UT 84401'}
                    className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none resize-y disabled:opacity-60"
                    style={inputStyle} />
                  <div className="text-[11px] mt-1 font-medium"
                    style={{ color: addressFooter.trim() ? 'var(--gc-text-3)' : '#c5221f' }}>
                    Required — sends refuse while this is empty (CAN-SPAM). Appended to every
                    outreach email alongside the unsubscribe link.
                  </div>
                </div>
              </div>

              {/* Intro email template — the manual "Send intro email" button. */}
              <div className="flex items-start gap-3">
                <label className="text-[12.5px] font-semibold w-36 shrink-0 pt-1.5" style={{ color: 'var(--gc-text-2)' }}>
                  Intro email
                </label>
                <div className="flex-1 min-w-0">
                  <input type="text" value={introSubject} disabled={!canManage}
                    onChange={e => setIntroSubject(e.target.value)}
                    placeholder="Following up: FleetCal for {{dba_or_legal_name}}"
                    className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60 mb-2"
                    style={inputStyle} />
                  <textarea rows={9} value={introBody} disabled={!canManage}
                    onChange={e => setIntroBody(e.target.value)}
                    className="w-full rounded-lg px-2.5 py-1.5 text-[12.5px] leading-[1.5] outline-none resize-y disabled:opacity-60"
                    style={inputStyle} />
                  <div className="text-[11px] mt-1 font-medium" style={{ color: 'var(--gc-text-3)' }}>
                    Sent one-off from a lead via the "Send intro email" button, typically right after a
                    call. Merge vars: {'{{dba_or_legal_name}} {{legal_name}} {{city}} {{state}} {{power_units}}'}.
                    Your signature, website line, and CAN-SPAM/unsubscribe footer are appended automatically.
                  </div>
                </div>
              </div>

              {/* Save */}
              <div className="flex items-center justify-end gap-3 pt-1"
                style={{ borderTop: '1px solid var(--gc-border-light)', paddingTop: 12 }}>
                {outreachMsg && (
                  <span className="text-[12px] font-semibold"
                    style={{ color: outreachMsg === 'Saved.' ? '#188038' : '#c5221f' }}>
                    {outreachMsg}
                  </span>
                )}
                <button onClick={() => void handleSaveOutreach()} disabled={!canManage || outreachSaving}
                  className="text-[12.5px] font-semibold px-4 py-2 rounded-lg transition-opacity disabled:opacity-50"
                  style={{ background: '#1a73e8', color: '#fff' }}>
                  {outreachSaving ? 'Saving…' : 'Save outreach settings'}
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
