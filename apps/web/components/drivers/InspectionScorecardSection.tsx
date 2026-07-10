'use client';

/**
 * InspectionScorecardSection — the compact per-driver inspection
 * scorecard that used to live at Equipment → Scorecard.
 *
 * Reads /v1/driver-scoring for the selected month, renders one row per
 * driver with completion % + pre/post trip counts + bonus badge. Kept
 * intentionally simple — the DriversView roster table below already
 * shows a broader operations picture; this section is a focused
 * "how's each driver doing on inspections THIS MONTH" view for the
 * bonus program.
 *
 * Monthly picker + cache-safe (5 min TTL — inspection numbers don't
 * change fast enough to warrant re-hitting the API on every open).
 */

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Trophy } from 'lucide-react';
import { railway } from '@/lib/railway';
import type { DriverScore, ListDriverScoresResponse } from '@fleetcal/types';

interface MonthOpt { key: string; label: string; from: string; to: string }

function buildMonthOptions(): MonthOpt[] {
  const iso = (d: Date) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const today = new Date();
  return Array.from({ length: 12 }, (_, i) => {
    const first = new Date(today.getFullYear(), today.getMonth() - i, 1);
    const lastOfMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    const to = i === 0 ? today : lastOfMonth; // clamp current month to today
    return {
      key: `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}`,
      label: first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      from: iso(first),
      to: iso(to),
    };
  });
}

// Module-level cache — keeps the response between panel opens.
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: ListDriverScoresResponse; cachedAt: number }>();

export default function InspectionScorecardSection() {
  const months = useMemo(buildMonthOptions, []);
  const [monthKey, setMonthKey] = useState(months[0].key);
  const sel = months.find(m => m.key === monthKey) ?? months[0];

  const cacheKey = `${sel.from}|${sel.to}`;
  const seeded = cache.get(cacheKey);
  const [data, setData] = useState<ListDriverScoresResponse | null>(seeded?.data ?? null);
  const [loading, setLoading] = useState(!seeded);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const cached = cache.get(cacheKey);
    const stale = !cached || (Date.now() - cached.cachedAt) > CACHE_TTL_MS;
    if (!stale) { setData(cached!.data); setLoading(false); return; }

    if (!data) setLoading(true);
    setError(null);
    railway.getDriverScoring({ from: sel.from, to: sel.to })
      .then(r => {
        if (cancelled) return;
        setData(r);
        cache.set(cacheKey, { data: r, cachedAt: Date.now() });
      })
      .catch(() => { if (!cancelled) setError('Failed to load driver scores.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  // The lint rule wants `data` in deps but including it re-runs the
  // effect after every setData — infinite loop. cacheKey is the only
  // real trigger; the rest are static month options.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  const threshold = data?.weights.bonusThreshold ?? 85;
  const scoreColor = (s: number) => s >= threshold ? '#1e8e3e' : s >= 60 ? '#b45309' : '#d93025';
  const scoreBg    = (s: number) => s >= threshold ? '#e6f4ea' : s >= 60 ? '#fef3c7' : '#fdecea';

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 12px', fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--gc-text-3)', whiteSpace: 'nowrap' };
  const td: React.CSSProperties = { padding: '11px 12px', fontSize: 13, color: 'var(--gc-text-1)', borderTop: '1px solid var(--gc-border-light)', whiteSpace: 'nowrap' };
  const num: React.CSSProperties = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div
      style={{
        border: '1px solid var(--gc-border-light)',
        borderRadius: 10,
        background: 'var(--gc-surface)',
        padding: '14px 16px',
        marginBottom: 14,
      }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3" style={{ marginBottom: 8 }}>
        <div className="flex items-center gap-2">
          <Trophy size={16} style={{ color: 'var(--gc-text-2)' }} />
          <h2 className="text-[14px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
            Inspection scorecard
          </h2>
        </div>
        <select
          value={monthKey}
          onChange={e => setMonthKey(e.target.value)}
          className="rounded-md px-2.5 py-1.5 text-[12.5px] font-medium"
          style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}
        >
          {months.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
        </select>
      </div>
      <p className="text-[12px] leading-relaxed" style={{ color: 'var(--gc-text-3)', marginBottom: 10 }}>
        Completion = inspection days ÷ days on the road, capped at 100%. One inspection
        per day covers that day. Bonus-eligible at {threshold}+.
      </p>

      {error && (
        <div className="rounded-lg text-[13px] py-2.5 px-3"
          style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' }}>
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="flex items-center gap-2 text-[13px] py-8 justify-center"
          style={{ color: 'var(--gc-text-3)' }}>
          <Loader2 size={16} className="animate-spin" /> Loading scores…
        </div>
      ) : !data || data.scores.length === 0 ? (
        <div className="rounded-lg text-[13px] py-8 px-4 text-center"
          style={{ background: 'var(--gc-bg)', border: '1px dashed var(--gc-border-light)', color: 'var(--gc-text-3)' }}>
          No driver activity in {sel.label}.
        </div>
      ) : (
        <div className="rounded-lg overflow-hidden overflow-x-auto"
          style={{ border: '1px solid var(--gc-border-light)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--gc-bg)' }}>
                <th style={th}>Driver</th>
                <th style={{ ...th, textAlign: 'right' }}>On road</th>
                <th style={{ ...th, textAlign: 'right' }}>Insp. days</th>
                <th style={{ ...th, textAlign: 'right' }}>Completion</th>
                <th style={{ ...th, textAlign: 'right' }}>Pre</th>
                <th style={{ ...th, textAlign: 'right' }}>Post</th>
                <th style={{ ...th, textAlign: 'right' }}>Score</th>
                <th style={{ ...th, textAlign: 'center' }}>Bonus</th>
              </tr>
            </thead>
            <tbody>
              {data.scores.map((s: DriverScore) => (
                <tr key={s.driverId}>
                  <td style={{ ...td, fontWeight: 600 }}>{s.driverName}</td>
                  <td style={num}>{s.activeDays}</td>
                  <td style={num}>{s.inspectionDays}</td>
                  <td style={num}>{s.completionPct}%</td>
                  <td style={num}>{s.preTrips}</td>
                  <td style={num}>{s.postTrips}</td>
                  <td style={num}>
                    <span
                      className="inline-flex items-center justify-center rounded-md font-bold"
                      style={{
                        minWidth: 40, padding: '3px 8px', fontSize: 13,
                        background: scoreBg(s.score), color: scoreColor(s.score),
                      }}
                    >
                      {s.score}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    {s.bonusEligible
                      ? <CheckCircle2 size={17} style={{ color: '#1e8e3e', display: 'inline' }} />
                      : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
