'use client';

/**
 * /crm/sequences — Phase-2 CRM: outreach sequence builder.
 *
 * Same triple gate as /crm. Left pane lists sequences (name, active
 * toggle, step count); selecting one opens the step editor: ordered
 * step cards (wait days + subject + body templates), add/remove/
 * reorder, and a live preview pane that renders the selected step
 * against a sample lead with client-side {{var}} substitution.
 *
 * Save replaces the FULL step list (PUT /v1/crm/sequences/:id/steps —
 * order = array order). Edits need crm.manage; viewing needs crm.access.
 */

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Target, ArrowLeft, Loader2, Plus, Trash2, ChevronUp, ChevronDown, ListPlus,
} from 'lucide-react';
import AppShell from '@/components/nav/AppShell';
import RequireCap from '@/components/auth/RequireCap';
import RequireInternalOrg from '@/components/crm/RequireInternalOrg';
import { usePermissions } from '@/lib/usePermissions';
import { railway, RailwayError } from '@/lib/railway';
import type { CrmSequence } from '@fleetcal/types';

// ── Merge vars + sample lead for the live preview ─────────────────────
// Mirrors the server-side renderer's variable set (packages/types/crm.ts
// CrmSequenceStep docs). The unsubscribe link + physical-address footer
// are auto-appended at SEND time — the preview only notes them.

const MERGE_VARS = [
  '{{legal_name}}', '{{dba_or_legal_name}}', '{{city}}', '{{state}}',
  '{{power_units}}', '{{unsubscribe_url}}',
] as const;

const SAMPLE_VARS: Record<string, string> = {
  legal_name:        'ACME TRUCKING LLC',
  dba_or_legal_name: 'Acme Trucking',
  city:              'Ogden',
  state:             'UT',
  power_units:       '6',
  unsubscribe_url:   'https://mail.example.com/u/sample',
};

function renderSample(tpl: string): string {
  return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => SAMPLE_VARS[key] ?? m);
}

/** Editor-side step shape — waitDays stays a string so partially typed
 *  values don't fight the cursor (cf. /crm/settings number inputs). */
interface EditStep {
  key:             number;
  /** Server ID — undefined for freshly-added rows until the next Save.
   *  Present-vs-absent gates the "Send test" button (only saved steps
   *  can be test-sent, otherwise we'd be sending the server's stale
   *  version of what's in the editor). */
  id?:             string;
  waitDays:        string;
  subjectTemplate: string;
  bodyTemplate:    string;
}

let nextKey = 1;

export default function CrmSequencesPage() {
  return (
    <RequireCap cap="crm.access" module="crm">
      <RequireInternalOrg>
        <CrmSequencesPageInner />
      </RequireInternalOrg>
    </RequireCap>
  );
}

function CrmSequencesPageInner() {
  const { can } = usePermissions();
  const canManage = can('crm.manage');

  const [sequences, setSequences] = useState<CrmSequence[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── New-sequence inline form ────────────────────────────────────────
  const [creating,  setCreating]  = useState(false);
  const [newName,   setNewName]   = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // ── Editor state ────────────────────────────────────────────────────
  const [steps,      setSteps]      = useState<EditStep[]>([]);
  const [dirty,      setDirty]      = useState(false);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [saving,     setSaving]     = useState(false);
  const [saveMsg,    setSaveMsg]    = useState<string | null>(null);

  // ── Test-send state ─────────────────────────────────────────────────
  // Recipient persists per-browser so a second test doesn't require
  // retyping the address. localStorage key is namespaced under the
  // page so it doesn't collide with anything else.
  const [testEmail,    setTestEmail]    = useState('');
  const [testSending,  setTestSending]  = useState(false);
  const [testMsg,      setTestMsg]      = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('crm-sequences-test-email');
      if (saved) setTestEmail(saved);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { window.localStorage.setItem('crm-sequences-test-email', testEmail); } catch { /* ignore */ }
  }, [testEmail]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { sequences: seqs } = await railway.crmListSequences();
        if (cancelled) return;
        setSequences(seqs);
        if (seqs.length > 0) setSelectedId(seqs[0].id);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof RailwayError ? `Failed to load sequences (${e.status})` : 'Failed to load sequences.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selected = useMemo(
    () => sequences.find(s => s.id === selectedId) ?? null,
    [sequences, selectedId],
  );

  // (Re)hydrate the editor whenever the selection changes.
  useEffect(() => {
    if (!selected) { setSteps([]); setDirty(false); return; }
    setSteps(selected.steps.map(s => ({
      key:             nextKey++,
      id:              s.id,
      waitDays:        String(s.waitDays),
      subjectTemplate: s.subjectTemplate,
      bodyTemplate:    s.bodyTemplate,
    })));
    setDirty(false);
    setPreviewIdx(0);
    setSaveMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ── Sequence CRUD ───────────────────────────────────────────────────

  async function handleCreate() {
    const name = newName.trim();
    if (!name || createBusy || !canManage) return;
    setCreateBusy(true);
    try {
      const { sequence } = await railway.crmCreateSequence(name);
      setSequences(prev => [sequence, ...prev]);
      setSelectedId(sequence.id);
      setNewName('');
      setCreating(false);
    } catch (e) {
      setError(e instanceof RailwayError ? `Failed to create sequence (${e.status})` : 'Failed to create sequence.');
    } finally {
      setCreateBusy(false);
    }
  }

  async function toggleActive(seq: CrmSequence) {
    if (!canManage) return;
    const next = !seq.isActive;
    // Optimistic — the API returns {ok}; roll back on failure.
    setSequences(prev => prev.map(s => (s.id === seq.id ? { ...s, isActive: next } : s)));
    try {
      await railway.crmPatchSequence(seq.id, { isActive: next });
    } catch {
      setSequences(prev => prev.map(s => (s.id === seq.id ? { ...s, isActive: seq.isActive } : s)));
      setError('Failed to update sequence.');
    }
  }

  // ── Step editing ────────────────────────────────────────────────────

  function patchStep(idx: number, patch: Partial<EditStep>) {
    setSteps(prev => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
    setDirty(true);
    setSaveMsg(null);
  }

  function addStep() {
    setSteps(prev => [...prev, {
      key: nextKey++,
      waitDays: prev.length === 0 ? '0' : '3',
      subjectTemplate: '',
      bodyTemplate: '',
    }]);
    setPreviewIdx(steps.length);
    setDirty(true);
    setSaveMsg(null);
  }

  function removeStep(idx: number) {
    setSteps(prev => prev.filter((_, i) => i !== idx));
    setPreviewIdx(p => Math.max(0, Math.min(p > idx ? p - 1 : p, steps.length - 2)));
    setDirty(true);
    setSaveMsg(null);
  }

  function moveStep(idx: number, dir: -1 | 1) {
    const to = idx + dir;
    if (to < 0 || to >= steps.length) return;
    setSteps(prev => {
      const next = [...prev];
      [next[idx], next[to]] = [next[to], next[idx]];
      return next;
    });
    setPreviewIdx(p => (p === idx ? to : p === to ? idx : p));
    setDirty(true);
    setSaveMsg(null);
  }

  async function handleSave() {
    if (!selected || saving || !canManage) return;
    // Mirror the API's validation so failures surface before the round trip.
    const errors: string[] = [];
    steps.forEach((s, i) => {
      const wait = Number(s.waitDays);
      if (!s.subjectTemplate.trim()) errors.push(`Step ${i + 1}: subject is required.`);
      if (!s.bodyTemplate.trim())    errors.push(`Step ${i + 1}: body is required.`);
      if (!Number.isFinite(wait) || wait < 0 || wait > 90) errors.push(`Step ${i + 1}: wait days must be 0–90.`);
    });
    if (errors.length > 0) { setSaveMsg(errors[0]); return; }
    setSaving(true);
    setSaveMsg(null);
    try {
      const { steps: savedSteps, rerendered } = await railway.crmReplaceSteps(
        selected.id,
        steps.map(s => ({
          waitDays:        Number(s.waitDays),
          subjectTemplate: s.subjectTemplate.trim(),
          bodyTemplate:    s.bodyTemplate.trim(),
        })),
      );
      setSequences(prev => prev.map(s => (s.id === selected.id ? { ...s, steps: savedSteps } : s)));
      setDirty(false);
      setSaveMsg(
        rerendered.updated > 0
          ? `Saved. Refreshed ${rerendered.updated} pending outbox email${rerendered.updated === 1 ? '' : 's'} with the new copy.`
          : 'Saved.',
      );
    } catch (e) {
      setSaveMsg(e instanceof RailwayError ? `Save failed (${e.status})` : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  const previewStep = steps[Math.min(previewIdx, steps.length - 1)] ?? null;

  /** Send the currently previewed step to the test recipient. Requires
   *  the sequence to be saved (each step needs a server id) and clean
   *  (otherwise the recipient sees the last-saved copy, not the
   *  in-editor copy, which is confusing). */
  async function handleSendTest() {
    if (!selected || !previewStep?.id || testSending) return;
    const to = testEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setTestMsg('Enter a valid recipient email.'); return;
    }
    setTestSending(true); setTestMsg(null);
    try {
      const r = await railway.crmSendTestStep(selected.id, previewStep.id, { to });
      setTestMsg(`Sent step ${r.stepOrder} to ${r.sentTo}. Check your inbox.`);
    } catch (e) {
      if (e instanceof RailwayError) {
        const d = e.detail as { detail?: string; error?: string } | null;
        const msg = d?.detail || d?.error || e.message;
        setTestMsg(`Send failed (${e.status}): ${msg}`);
      } else {
        setTestMsg('Send failed.');
      }
    } finally {
      setTestSending(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: 'var(--gc-bg)',
    border:     '1px solid var(--gc-border-light)',
    color:      'var(--gc-text-1)',
  };

  return (
    <AppShell title="CRM sequences" icon={Target} noPageScroll>
      <div className="flex-1 flex flex-col min-h-0 px-6 py-5 gap-4">
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/crm"
            className="inline-flex items-center gap-1.5 text-[12.5px] font-medium"
            style={{ color: 'var(--gc-text-2)', textDecoration: 'none' }}>
            <ArrowLeft size={13} /> Back to leads
          </Link>
          <div className="flex-1" />
          {canManage && !creating && (
            <button onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-colors"
              style={{ background: '#1a73e8', color: '#fff' }}>
              <Plus size={12} /> New sequence
            </button>
          )}
          {canManage && creating && (
            <div className="flex items-center gap-2">
              <input type="text" autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void handleCreate();
                  if (e.key === 'Escape') { setCreating(false); setNewName(''); }
                }}
                placeholder="Sequence name…"
                className="text-[13px] px-2.5 py-1.5 rounded-lg outline-none"
                style={{ width: 220, background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-1)' }} />
              <button onClick={() => void handleCreate()} disabled={!newName.trim() || createBusy}
                className="text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                style={{ background: '#1a73e8', color: '#fff' }}>
                {createBusy ? 'Creating…' : 'Create'}
              </button>
              <button onClick={() => { setCreating(false); setNewName(''); }}
                className="text-[12px] font-medium px-2 py-1.5 rounded-lg hover:bg-[var(--gc-hover)]"
                style={{ color: 'var(--gc-text-2)' }}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl p-3 text-[13px]" style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca' }}>
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={18} className="animate-spin" />
          </div>
        ) : sequences.length === 0 ? (
          <div className="rounded-2xl px-5 py-10 text-center"
            style={{ background: 'var(--gc-surface)', border: '1px dashed var(--gc-border)' }}>
            <ListPlus size={20} className="inline mb-2" style={{ color: 'var(--gc-text-3)' }} />
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>No sequences yet</div>
            <div className="text-[12px] mt-1" style={{ color: 'var(--gc-text-3)' }}>
              {canManage
                ? 'Create your first outreach sequence to start enrolling leads.'
                : 'Creating sequences requires the crm.manage capability.'}
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex gap-4">

            {/* Sequence list */}
            <div className="w-[260px] shrink-0 flex flex-col gap-2 overflow-y-auto">
              {sequences.map(seq => {
                const active = seq.id === selectedId;
                return (
                  <button key={seq.id}
                    onClick={() => setSelectedId(seq.id)}
                    className="text-left rounded-xl px-3.5 py-3 transition-colors"
                    style={{
                      background: active ? 'var(--gc-surface)' : 'transparent',
                      border: `1px solid ${active ? 'var(--gc-border)' : 'var(--gc-border-light)'}`,
                      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.06)' : 'none',
                    }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
                        {seq.name}
                      </span>
                      <span className="px-2 py-0.5 rounded-lg text-[10px] font-extrabold shrink-0"
                        style={seq.isActive
                          ? { background: '#e6f4ea', color: '#188038' }
                          : { background: '#f1f3f4', color: '#5f6368' }}>
                        {seq.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between mt-1.5">
                      <span className="text-[11.5px] tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                        {seq.steps.length} step{seq.steps.length === 1 ? '' : 's'}
                      </span>
                      <label className="inline-flex items-center gap-1.5 text-[11.5px] font-medium cursor-pointer select-none"
                        style={{ color: 'var(--gc-text-2)', opacity: canManage ? 1 : 0.5 }}
                        onClick={e => e.stopPropagation()}>
                        <input type="checkbox"
                          checked={seq.isActive}
                          disabled={!canManage}
                          onChange={() => void toggleActive(seq)}
                          style={{ accentColor: '#188038' }} />
                        Active
                      </label>
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Editor + preview */}
            {selected && (
              <div className="flex-1 min-w-0 min-h-0 flex gap-4">

                {/* Step editor */}
                <div className="flex-1 min-w-0 min-h-0 flex flex-col rounded-2xl overflow-hidden"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                  <div className="flex items-center gap-3 px-4 py-3"
                    style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                    <div className="min-w-0">
                      <div className="text-[14px] font-bold truncate" style={{ color: 'var(--gc-text-1)' }}>
                        {selected.name}
                      </div>
                      <div className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
                        Steps send in order; each waits N days after the previous step.
                      </div>
                    </div>
                    <div className="flex-1" />
                    {saveMsg && (
                      <span className="text-[12px] font-semibold"
                        style={{ color: saveMsg?.startsWith('Saved') ? '#188038' : '#c5221f' }}>
                        {saveMsg}
                      </span>
                    )}
                    {canManage && (
                      <button onClick={() => void handleSave()} disabled={!dirty || saving}
                        className="text-[12.5px] font-semibold px-4 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                        style={{ background: '#1a73e8', color: '#fff' }}>
                        {saving ? 'Saving…' : 'Save steps'}
                      </button>
                    )}
                  </div>

                  {/* Merge-var hint chips */}
                  <div className="flex items-center gap-1.5 flex-wrap px-4 py-2.5"
                    style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                    <span className="text-[11px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>
                      Merge vars:
                    </span>
                    {MERGE_VARS.map(v => (
                      <code key={v} className="px-1.5 py-0.5 rounded text-[10.5px] font-semibold"
                        style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-2)' }}>
                        {v}
                      </code>
                    ))}
                  </div>

                  <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 flex flex-col gap-3">
                    {steps.length === 0 && (
                      <div className="text-[13px] italic py-6 text-center" style={{ color: 'var(--gc-text-3)' }}>
                        No steps yet — an enrolled lead gets nothing until you add one.
                      </div>
                    )}
                    {steps.map((step, idx) => (
                      <div key={step.key}
                        onClick={() => setPreviewIdx(idx)}
                        className="rounded-xl px-3.5 py-3 flex flex-col gap-2 cursor-pointer"
                        style={{
                          background: 'var(--gc-bg)',
                          border: `1px solid ${idx === previewIdx ? '#1a73e8' : 'var(--gc-border-light)'}`,
                        }}>
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] font-extrabold uppercase tracking-wider"
                            style={{ color: 'var(--gc-text-2)' }}>
                            Step {idx + 1}
                          </span>
                          <div className="flex items-center gap-1.5 ml-2">
                            <input type="number" min={0} max={90}
                              value={step.waitDays}
                              disabled={!canManage}
                              onClick={e => e.stopPropagation()}
                              onFocus={() => setPreviewIdx(idx)}
                              onChange={e => patchStep(idx, { waitDays: e.target.value })}
                              className="w-16 rounded-lg px-2 py-1 text-[12.5px] outline-none tabular-nums disabled:opacity-60"
                              style={inputStyle} />
                            <span className="text-[11.5px]" style={{ color: 'var(--gc-text-3)' }}>
                              days after previous step
                            </span>
                          </div>
                          <div className="flex-1" />
                          {canManage && (
                            <div className="flex items-center gap-0.5">
                              <button onClick={e => { e.stopPropagation(); moveStep(idx, -1); }}
                                disabled={idx === 0}
                                className="p-1 rounded hover:bg-[var(--gc-hover)] disabled:opacity-30"
                                title="Move up">
                                <ChevronUp size={14} style={{ color: 'var(--gc-text-2)' }} />
                              </button>
                              <button onClick={e => { e.stopPropagation(); moveStep(idx, 1); }}
                                disabled={idx === steps.length - 1}
                                className="p-1 rounded hover:bg-[var(--gc-hover)] disabled:opacity-30"
                                title="Move down">
                                <ChevronDown size={14} style={{ color: 'var(--gc-text-2)' }} />
                              </button>
                              <button onClick={e => { e.stopPropagation(); removeStep(idx); }}
                                className="p-1 rounded hover:bg-[var(--gc-hover)]"
                                title="Remove step">
                                <Trash2 size={13} style={{ color: '#c5221f' }} />
                              </button>
                            </div>
                          )}
                        </div>
                        <input type="text"
                          value={step.subjectTemplate}
                          disabled={!canManage}
                          onClick={e => e.stopPropagation()}
                          onFocus={() => setPreviewIdx(idx)}
                          onChange={e => patchStep(idx, { subjectTemplate: e.target.value })}
                          placeholder="Subject — e.g. Quick question for {{dba_or_legal_name}}"
                          className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60"
                          style={inputStyle} />
                        <textarea
                          value={step.bodyTemplate}
                          disabled={!canManage}
                          rows={5}
                          onClick={e => e.stopPropagation()}
                          onFocus={() => setPreviewIdx(idx)}
                          onChange={e => patchStep(idx, { bodyTemplate: e.target.value })}
                          placeholder={'Hi {{dba_or_legal_name}},\n\nSaw you run {{power_units}} trucks out of {{city}}, {{state}}…'}
                          className="w-full rounded-lg px-2.5 py-1.5 text-[13px] outline-none resize-y disabled:opacity-60"
                          style={inputStyle} />
                      </div>
                    ))}
                    {canManage && (
                      <button onClick={addStep}
                        className="inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold px-3 py-2 rounded-xl transition-colors hover:bg-[var(--gc-hover)]"
                        style={{ border: '1px dashed var(--gc-border)', color: 'var(--gc-text-2)' }}>
                        <Plus size={13} /> Add step
                      </button>
                    )}
                  </div>
                </div>

                {/* Live preview */}
                <div className="w-[360px] shrink-0 min-h-0 flex flex-col rounded-2xl overflow-hidden"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                  <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                    <div className="text-[12px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
                      Preview {previewStep ? `— step ${Math.min(previewIdx, steps.length - 1) + 1}` : ''}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                      Rendered against a sample lead ({SAMPLE_VARS.dba_or_legal_name}, {SAMPLE_VARS.city}, {SAMPLE_VARS.state}).
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                    {!previewStep ? (
                      <div className="text-[13px] italic py-6 text-center" style={{ color: 'var(--gc-text-3)' }}>
                        Add a step to preview it.
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3">
                        <div>
                          <div className="text-[10.5px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>Subject</div>
                          <div className="text-[13px] font-semibold mt-0.5" style={{ color: 'var(--gc-text-1)' }}>
                            {renderSample(previewStep.subjectTemplate) || <span className="italic" style={{ color: 'var(--gc-text-3)' }}>empty</span>}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10.5px] font-semibold" style={{ color: 'var(--gc-text-3)' }}>Body</div>
                          <div className="text-[13px] mt-0.5 whitespace-pre-wrap break-words" style={{ color: 'var(--gc-text-1)' }}>
                            {renderSample(previewStep.bodyTemplate) || <span className="italic" style={{ color: 'var(--gc-text-3)' }}>empty</span>}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="px-4 py-2.5 text-[11px]"
                    style={{ borderTop: '1px solid var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
                    An unsubscribe link and the CAN-SPAM physical-address footer are auto-appended
                    at send time (configure the footer in CRM settings).
                  </div>
                  {canManage && (
                    <div className="px-4 py-3 flex flex-col gap-2"
                      style={{ borderTop: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
                      <div className="text-[11.5px] font-bold" style={{ color: 'var(--gc-text-2)' }}>
                        Test send
                      </div>
                      <input
                        type="email"
                        value={testEmail}
                        onChange={e => setTestEmail(e.target.value)}
                        placeholder="matt@fleetcalendar.app"
                        className="rounded-lg px-2.5 py-1.5 text-[12.5px] outline-none"
                        style={inputStyle} />
                      <button
                        onClick={() => void handleSendTest()}
                        disabled={
                          testSending ||
                          !previewStep ||
                          !previewStep.id ||
                          dirty ||
                          !testEmail.trim()
                        }
                        title={
                          !previewStep
                            ? 'Add a step to test.'
                            : !previewStep.id
                              ? 'Save the sequence first — new steps have no server id yet.'
                              : dirty
                                ? 'Save your changes first — the test would send the last-saved copy, not what you see in the editor.'
                                : ''
                        }
                        className="text-[12px] font-semibold px-3 py-1.5 rounded-lg transition-opacity disabled:opacity-50"
                        style={{ background: '#1a73e8', color: '#fff' }}>
                        {testSending
                          ? 'Sending…'
                          : previewStep
                            ? `Send step ${Math.min(previewIdx, steps.length - 1) + 1} to my inbox`
                            : 'Send test'}
                      </button>
                      {testMsg && (
                        <div className="text-[11.5px] font-semibold"
                          style={{ color: testMsg.startsWith('Sent') ? '#188038' : '#c5221f' }}>
                          {testMsg}
                        </div>
                      )}
                      <div className="text-[10.5px]" style={{ color: 'var(--gc-text-3)' }}>
                        Real send via Resend from your outreach domain. Subject prefixed
                        <code className="mx-0.5 px-1 rounded" style={{ background: 'var(--gc-border-light)' }}>[TEST]</code>.
                        No outbox row, no daily-cap impact.
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  );
}
