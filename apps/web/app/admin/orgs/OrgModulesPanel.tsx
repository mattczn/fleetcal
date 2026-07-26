'use client';

/**
 * Inline per-org module control, rendered inside an expanded row of
 * the /admin/orgs table. Backed by /api/admin/orgs/:orgId/modules.
 *
 * Why it lives in the orgs table rather than its own page: the flags
 * only make sense next to the org's activity (tier, truck count,
 * whether they've ever created a load), and the super-admin's job
 * here is "scan the list, fix the one org that's wrong" — a
 * drill-down route would put a navigation round-trip in the middle
 * of that loop.
 *
 * Settings → Modules is the customer-facing twin of this panel, but
 * it edits the CALLER'S own org and its nav entry is gated to
 * internal orgs, so it can't manage a carrier you aren't a member of.
 *
 * Modules are bucketed by their launch default rather than a
 * hand-maintained list, so the sections stay honest when
 * MVP_LAUNCH_DEFAULTS changes in code:
 *
 *   Included      — default true  (what an MVP signup gets)
 *   Add-ons       — default false (flip on per customer)
 *   Internal only — DEFAULT_OFF_MODULES (never for a customer)
 *
 * A "CUSTOM" chip marks any module whose value differs from the
 * launch default, so it's obvious what's been special-cased.
 */

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import {
  DEFAULT_OFF_MODULES,
  MVP_LAUNCH_DEFAULTS,
  ORG_MODULES,
  ORG_MODULE_BLURB,
  ORG_MODULE_LABEL,
  type OrgModule,
} from '@fleetcal/types';
import { AlertCircle, Check, Loader2, ShieldAlert } from 'lucide-react';

interface ApiResponse {
  orgId:           string;
  orgName:         string;
  modules:         Record<string, boolean>;
  storedOverrides: Record<string, boolean>;
  internalOnly:    string[];
}

type Flags = Record<string, boolean>;

interface Section {
  key:   'included' | 'addon' | 'internal';
  title: string;
  blurb: string;
}

const SECTIONS: Section[] = [
  { key: 'included', title: 'Included in the MVP', blurb: 'On by default for every new carrier.' },
  { key: 'addon',    title: 'Add-ons',             blurb: 'Off by default — flip on per customer.' },
  { key: 'internal', title: 'Internal only',       blurb: 'FleetCal tooling. Keep off for customers.' },
];

function sectionFor(module: OrgModule): Section['key'] {
  if (DEFAULT_OFF_MODULES.has(module)) return 'internal';
  return MVP_LAUNCH_DEFAULTS[module] ? 'included' : 'addon';
}

export default function OrgModulesPanel({ orgId, orgName, dirtyRef }: {
  orgId:   string;
  orgName: string;
  /** Written on every dirty-state change so the parent row can warn
   *  before collapsing away unsaved toggles. A ref rather than a
   *  callback-with-state so the parent doesn't re-render the whole
   *  orgs table on each toggle. */
  dirtyRef?: RefObject<boolean>;
}) {
  const [data, setData]       = useState<ApiResponse | null>(null);
  const [draft, setDraft]     = useState<Flags>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orgs/${encodeURIComponent(orgId)}/modules`);
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      const json = await res.json() as ApiResponse;
      setData(json);
      setDraft(json.modules);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  // Only the modules that actually changed — the API merges a sparse
  // patch, so sending the whole map would stamp every inherited key
  // as an explicit override for no reason.
  const changed = useMemo(() => {
    if (!data) return {} as Flags;
    const out: Flags = {};
    for (const m of ORG_MODULES) {
      if (draft[m] !== data.modules[m]) out[m] = draft[m];
    }
    return out;
  }, [draft, data]);

  const changedCount = Object.keys(changed).length;
  const isDirty      = changedCount > 0;

  // Publish dirty state upward, and clear it on unmount so a collapsed
  // (and therefore discarded) panel can't leave the row thinking it
  // still has pending edits.
  useEffect(() => {
    if (!dirtyRef) return;
    dirtyRef.current = isDirty;
    return () => { dirtyRef.current = false; };
  }, [isDirty, dirtyRef]);

  const toggle = (module: OrgModule) => {
    const next = !draft[module];
    // Turning internal tooling ON for a customer org is the one change
    // here that exposes a surface we never sell. Confirm it; turning
    // one OFF needs no ceremony.
    if (next && DEFAULT_OFF_MODULES.has(module)) {
      const ok = window.confirm(
        `${ORG_MODULE_LABEL[module]} is FleetCal-internal tooling, not a customer feature.\n\n` +
        `Enable it for "${orgName}"?`,
      );
      if (!ok) return;
    }
    setDraft(prev => ({ ...prev, [module]: next }));
    setSavedAt(null);
  };

  const revert = () => {
    if (data) setDraft(data.modules);
    setSavedAt(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/orgs/${encodeURIComponent(orgId)}/modules`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ modules: changed }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 160)}`);
      }
      const json = await res.json() as ApiResponse;
      setData(prev => (prev ? { ...prev, ...json } : json));
      setDraft(json.modules);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex items-center gap-2 py-6 justify-center text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
        <Loader2 size={13} className="animate-spin" /> Loading modules…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      {error && (
        <div className="text-[12px] px-3 py-2 rounded-lg"
          style={{ background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca' }}>
          <AlertCircle size={12} className="inline mr-1" /> {error}
        </div>
      )}

      <div className="text-[11.5px]" style={{ color: 'var(--gc-text-3)', lineHeight: 1.5 }}>
        A module that&apos;s OFF is invisible to everyone in the org — the nav link disappears and the API
        refuses the route, whatever the user&apos;s role. Saves reach the API within about a minute
        (it caches each org&apos;s flags in-process for 60 seconds).
      </div>

      {data && (
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
          {SECTIONS.map(section => {
            const modules = ORG_MODULES.filter(m => sectionFor(m) === section.key);
            if (modules.length === 0) return null;
            return (
              <div key={section.key} className="rounded-lg"
                style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--gc-border-light)' }}>
                  <div className="text-[10.5px] font-bold uppercase tracking-wider inline-flex items-center gap-1"
                    style={{ color: section.key === 'internal' ? '#b06000' : 'var(--gc-text-3)' }}>
                    {section.key === 'internal' && <ShieldAlert size={11} />}
                    {section.title} · {modules.length}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                    {section.blurb}
                  </div>
                </div>
                {modules.map((module, idx) => (
                  <ModuleRow
                    key={module}
                    module={module}
                    enabled={!!draft[module]}
                    isCustom={draft[module] !== MVP_LAUNCH_DEFAULTS[module]}
                    isPending={module in changed}
                    first={idx === 0}
                    onToggle={() => toggle(module)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => void save()}
          disabled={!isDirty || saving}
          className="text-[12px] font-semibold px-3 py-1.5 rounded-lg inline-flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: isDirty ? '#1558d6' : 'var(--gc-surface)',
                   color:      isDirty ? '#fff' : 'var(--gc-text-3)',
                   border:     '1px solid ' + (isDirty ? '#1558d6' : 'var(--gc-border)') }}>
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {saving ? 'Saving…' : isDirty ? `Save ${changedCount} change${changedCount === 1 ? '' : 's'}` : 'Saved'}
        </button>
        {isDirty && (
          <button onClick={revert}
            disabled={saving}
            className="text-[12px] font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
            Revert
          </button>
        )}
        {savedAt && !isDirty && (
          <span className="text-[11.5px]" style={{ color: '#137333' }}>
            Saved at {new Date(savedAt).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Bits ──

function ModuleRow({ module, enabled, isCustom, isPending, first, onToggle }: {
  module:    OrgModule;
  enabled:   boolean;
  isCustom:  boolean;
  isPending: boolean;
  first:     boolean;
  onToggle:  () => void;
}) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5"
      style={{ borderTop: first ? 'none' : '1px solid var(--gc-border-light)',
               background: isPending ? 'rgba(21,88,214,0.05)' : undefined }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12.5px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
            {ORG_MODULE_LABEL[module]}
          </span>
          {isCustom && (
            <span className="text-[9.5px] font-bold px-1 py-0.5 rounded"
              style={{ background: '#f3e8fd', color: '#6b21a8' }}
              title={`Differs from the launch default (${MVP_LAUNCH_DEFAULTS[module] ? 'on' : 'off'})`}>
              CUSTOM
            </span>
          )}
          {isPending && (
            <span className="text-[9.5px] font-bold px-1 py-0.5 rounded"
              style={{ background: '#e8f0fe', color: '#1558d6' }}>
              UNSAVED
            </span>
          )}
        </div>
        <div className="text-[11.5px] mt-0.5" style={{ color: 'var(--gc-text-3)', lineHeight: 1.45 }}>
          {ORG_MODULE_BLURB[module]}
        </div>
      </div>
      <Toggle checked={enabled} onChange={onToggle} label={ORG_MODULE_LABEL[module]} />
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      className="shrink-0 mt-0.5 rounded-full transition-colors"
      style={{
        width: 34, height: 20, padding: 2,
        background: checked ? '#1558d6' : 'var(--gc-border)',
        border: 'none', cursor: 'pointer',
      }}>
      <span style={{
        display: 'block', width: 16, height: 16, borderRadius: '50%',
        background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
        transform: `translateX(${checked ? 14 : 0}px)`,
        transition: 'transform 120ms ease',
      }} />
    </button>
  );
}
