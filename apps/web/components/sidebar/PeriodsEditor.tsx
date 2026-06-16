'use client';

/**
 * PeriodsEditor — multi-period activity editor for an asset.
 *
 * Replaces LifecycleEditor for assets. An asset has 1+ activity periods
 * (start_date → end_date, end_date NULL = currently open). Default is
 * a single period, which renders almost identically to the old single-
 * range Lifecycle editor. The "+ New activity period" button only
 * appears when the current period is CLOSED — you can't have two open
 * periods at once.
 *
 * Real-world use case (the reason this exists): a truck goes out for
 * engine rebuild in March, comes back in May, retires for good in
 * September. With single active_from/active_to, dispatchers worked
 * around this by creating a duplicate asset row when the truck came
 * back online, splitting history across two asset_ids and breaking
 * reporting + ELD linkage. Multi-period keeps everything on one row.
 *
 * Reads/writes go through the railway client. The store's asset.activeFrom
 * and asset.activeTo are kept in sync server-side by a DB trigger; we
 * don't write to them directly from this component.
 */
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Pencil, Check, X, HelpCircle, Trash2 } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { AssetActivityPeriod } from '@/lib/railway';
import { errorToast } from '@/lib/errorToast';
import { toast } from 'sonner';
import { useCalendarStore } from '@/store/useCalendarStore';
import DatePicker from '@/components/calendar/DatePicker';

interface Props {
  assetId: number;
  /** Color accent for the Save buttons + focus borders. */
  accent: string;
  /** When false, all interactive controls render disabled / read-only. */
  canEdit?: boolean;
}

function todayKey(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—';
  // YYYY-MM-DD → "Jan 15, 2026" in the user's locale
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return s;
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function PeriodsEditor({ assetId, accent, canEdit = true }: Props) {
  const [periods, setPeriods] = useState<AssetActivityPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy,    setBusy]    = useState(false);
  /** Per-period edit state, keyed by period id. */
  const [editing, setEditing] = useState<Record<number, { startDate: string; endDate: string }>>({});
  /** Add-new-period form state. Null when the form is closed. */
  const [adding,  setAdding]  = useState<{ startDate: string; endDate: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { periods } = await railway.listAssetPeriods(assetId);
      setPeriods(periods);
      // Mirror the DB trigger locally so the calendar/picker/etc.
      // reflect the new active state without a full page reload:
      //   active_from = MIN(start_date)
      //   active_to   = NULL if any open period exists; else MAX(end_date)
      // Direct Zustand setState (not the public updateAsset action, which
      // would PATCH the server back with stale values that the trigger
      // has already correctly computed).
      const sorted = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));
      const activeFrom = sorted.length > 0 ? sorted[0].startDate : null;
      const hasOpen    = periods.some((p) => p.endDate === null);
      const lastEnd    = periods.reduce<string | null>((max, p) => {
        if (!p.endDate) return max;
        return !max || p.endDate > max ? p.endDate : max;
      }, null);
      const activeTo = hasOpen ? null : lastEnd;
      useCalendarStore.setState((state) => ({
        assets: state.assets.map((a) =>
          a.id === assetId
            ? { ...a, activeFrom: activeFrom ?? a.activeFrom, activeTo }
            : a,
        ),
      }));
    } catch (e) {
      console.error('[PeriodsEditor] list failed:', e);
      errorToast(e, 'Failed to load activity periods');
    } finally {
      setLoading(false);
    }
  }, [assetId]);

  useEffect(() => { setLoading(true); void refresh(); }, [refresh]);

  const openPeriod   = periods.find((p) => p.endDate === null) ?? null;
  const hasOpen      = openPeriod !== null;
  const sortedAsc    = [...periods].sort((a, b) => a.startDate.localeCompare(b.startDate));

  async function closePeriod(period: AssetActivityPeriod) {
    if (busy || !canEdit) return;
    setBusy(true);
    try {
      await railway.updateAssetPeriod(assetId, period.id, { endDate: todayKey() });
      toast.success(`Closed period — ${period.assetId}`);
      await refresh();
    } catch (e) {
      errorToast(e, 'Failed to close period');
    } finally {
      setBusy(false);
    }
  }

  async function savePeriodEdit(period: AssetActivityPeriod) {
    if (busy || !canEdit) return;
    const draft = editing[period.id];
    if (!draft) return;
    const payload: { startDate?: string; endDate?: string | null } = {};
    if (draft.startDate !== period.startDate) payload.startDate = draft.startDate;
    const draftEnd = draft.endDate === '' ? null : draft.endDate;
    if (draftEnd !== period.endDate) payload.endDate = draftEnd;
    if (Object.keys(payload).length === 0) {
      setEditing((s) => { const { [period.id]: _, ...rest } = s; return rest; });
      return;
    }
    setBusy(true);
    try {
      await railway.updateAssetPeriod(assetId, period.id, payload);
      setEditing((s) => { const { [period.id]: _, ...rest } = s; return rest; });
      await refresh();
    } catch (e) {
      errorToast(e, 'Failed to update period');
    } finally {
      setBusy(false);
    }
  }

  async function createNewPeriod() {
    if (busy || !canEdit || !adding) return;
    if (!adding.startDate) return;
    setBusy(true);
    try {
      await railway.createAssetPeriod(assetId, {
        startDate: adding.startDate,
        endDate:   adding.endDate === '' ? null : adding.endDate,
      });
      setAdding(null);
      await refresh();
    } catch (e) {
      errorToast(e, 'Failed to create period');
    } finally {
      setBusy(false);
    }
  }

  async function deletePeriod(period: AssetActivityPeriod) {
    if (busy || !canEdit) return;
    if (!confirm(`Delete this activity period (${fmtDate(period.startDate)} → ${fmtDate(period.endDate) || 'open'})? This won't affect historical loads.`)) return;
    setBusy(true);
    try {
      await railway.deleteAssetPeriod(assetId, period.id);
      await refresh();
    } catch (e) {
      errorToast(e, 'Failed to delete period');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 pt-6" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
      <div className="flex items-center gap-2 mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
          Activity periods
        </div>
        <span
          title="Each period is a continuous window when the truck was in service. Most trucks have one — start to retire. Add more when a truck comes back into service after being out (engine rebuild, chassis swap, etc.). Historical loads always stay attached to this truck regardless of period changes."
          style={{ color: 'var(--gc-text-3)', cursor: 'help' }}
        >
          <HelpCircle size={12} />
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-[12px] py-2" style={{ color: 'var(--gc-text-3)' }}>
          <Loader2 size={12} className="animate-spin" /> Loading periods…
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {sortedAsc.map((period) => {
              const isOpen     = period.endDate === null;
              const draft      = editing[period.id];
              const inEditMode = !!draft;

              if (inEditMode) {
                const invalid = !!draft.endDate && draft.endDate < draft.startDate;
                return (
                  <div key={period.id}
                    className="rounded-lg p-3"
                    style={{ background: 'var(--gc-surface-2)', border: '1px solid var(--gc-border)' }}>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                          Start
                        </label>
                        <DatePicker
                          value={draft.startDate}
                          onChange={(v) => setEditing((s) => ({ ...s, [period.id]: { ...s[period.id], startDate: v } }))}
                          headerColor={accent}
                          required
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                          End <span style={{ color: 'var(--gc-text-3)', fontWeight: 400, textTransform: 'none' }}>(blank = open)</span>
                        </label>
                        <DatePicker
                          value={draft.endDate}
                          onChange={(v) => setEditing((s) => ({ ...s, [period.id]: { ...s[period.id], endDate: v } }))}
                          headerColor={accent}
                          min={draft.startDate || undefined}
                        />
                      </div>
                    </div>
                    {invalid && (
                      <div className="mt-2 text-[11px]" style={{ color: '#d93025' }}>
                        End date must be on or after start.
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2">
                      <button type="button"
                        onClick={() => savePeriodEdit(period)}
                        disabled={busy || invalid}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium text-white transition-opacity"
                        style={{ background: accent, opacity: (busy || invalid) ? 0.5 : 1, cursor: (busy || invalid) ? 'not-allowed' : 'pointer' }}>
                        <Check size={12} /> Save
                      </button>
                      <button type="button"
                        onClick={() => setEditing((s) => { const { [period.id]: _, ...rest } = s; return rest; })}
                        disabled={busy}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors"
                        style={{ color: 'var(--gc-text-2)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                        <X size={12} /> Cancel
                      </button>
                    </div>
                  </div>
                );
              }

              return (
                <div key={period.id}
                  className="flex items-center justify-between rounded-lg px-3 py-2"
                  style={{ background: 'var(--gc-surface-2)', border: '1px solid var(--gc-border-light)' }}>
                  <div className="flex items-center gap-3">
                    {isOpen && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ background: '#1e8e3e', color: 'white' }}>
                        <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> Active
                      </span>
                    )}
                    <span className="text-[13px]" style={{ color: 'var(--gc-text-1)' }}>
                      <strong>{fmtDate(period.startDate)}</strong>
                      <span style={{ color: 'var(--gc-text-3)', margin: '0 8px' }}>→</span>
                      {isOpen ? (
                        <span style={{ color: 'var(--gc-text-3)' }}>currently active</span>
                      ) : (
                        <strong>{fmtDate(period.endDate)}</strong>
                      )}
                    </span>
                  </div>
                  {canEdit && (
                    <div className="flex items-center gap-1">
                      {isOpen && (
                        <button type="button"
                          onClick={() => closePeriod(period)}
                          disabled={busy}
                          className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
                          style={{ color: '#d93025', background: 'transparent' }}
                          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(217,48,37,0.08)')}
                          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                          Close period
                        </button>
                      )}
                      <button type="button"
                        onClick={() => setEditing((s) => ({ ...s, [period.id]: { startDate: period.startDate, endDate: period.endDate ?? '' } }))}
                        disabled={busy}
                        title="Edit dates"
                        className="p-1.5 rounded-md transition-colors"
                        style={{ color: 'var(--gc-text-2)' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                        <Pencil size={12} />
                      </button>
                      {periods.length > 1 && (
                        <button type="button"
                          onClick={() => deletePeriod(period)}
                          disabled={busy}
                          title="Delete this period (won't affect historical loads)"
                          className="p-1.5 rounded-md transition-colors"
                          style={{ color: 'var(--gc-text-3)' }}
                          onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(217,48,37,0.08)'; e.currentTarget.style.color = '#d93025'; }}
                          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent';      e.currentTarget.style.color = 'var(--gc-text-3)'; }}>
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* + New activity period — only shown when no open period exists.
              Tooltip on the button explains the feature so dispatchers
              know when to reach for it. */}
          {adding ? (
            <div className="mt-3 rounded-lg p-3"
              style={{ background: 'var(--gc-surface-2)', border: '1px solid var(--gc-border)' }}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                    Start
                  </label>
                  <DatePicker
                    value={adding.startDate}
                    onChange={(v) => setAdding((s) => s ? { ...s, startDate: v } : s)}
                    headerColor={accent}
                    required
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gc-text-3)' }}>
                    End <span style={{ color: 'var(--gc-text-3)', fontWeight: 400, textTransform: 'none' }}>(blank = open)</span>
                  </label>
                  <DatePicker
                    value={adding.endDate}
                    onChange={(v) => setAdding((s) => s ? { ...s, endDate: v } : s)}
                    headerColor={accent}
                    min={adding.startDate || undefined}
                  />
                </div>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button type="button"
                  onClick={createNewPeriod}
                  disabled={busy || !adding.startDate}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium text-white transition-opacity"
                  style={{ background: accent, opacity: (busy || !adding.startDate) ? 0.5 : 1, cursor: (busy || !adding.startDate) ? 'not-allowed' : 'pointer' }}>
                  <Check size={12} /> Add period
                </button>
                <button type="button"
                  onClick={() => setAdding(null)}
                  disabled={busy}
                  className="flex items-center gap-1.5 px-3 py-1 rounded-md text-[12px] font-medium transition-colors"
                  style={{ color: 'var(--gc-text-2)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                  <X size={12} /> Cancel
                </button>
              </div>
            </div>
          ) : (
            canEdit && !hasOpen && (
              <button type="button"
                onClick={() => setAdding({ startDate: todayKey(), endDate: '' })}
                disabled={busy}
                title="Use this when a truck comes back into service after being retired — like after an engine rebuild or chassis swap. Each period keeps its own dates so your timeline and reporting stay accurate."
                className="mt-3 flex items-center gap-2 px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors"
                style={{ color: accent, border: `1px dashed ${accent}`, background: 'transparent' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}>
                <Plus size={13} />
                New activity period
              </button>
            )
          )}

          {/* Friendly empty-state explainer when there's only one period
              and it's still open — the most common case. Reassures the
              dispatcher that they don't need to do anything special and
              hints at when they would. */}
          {sortedAsc.length === 1 && hasOpen && !adding && (
            <p className="mt-3 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
              Most trucks need only one period. Close it (Retire) when this truck leaves service for good — or temporarily, then start a new period when it comes back.
            </p>
          )}
        </>
      )}
    </div>
  );
}
