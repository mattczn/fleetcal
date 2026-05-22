/**
 * CostAnalysisPanel — experimental Claude-powered cost-per-load view.
 *
 * Lives as a third tab in AssetDetailModal next to Movements and
 * Odometer. Read the spec / pipeline at
 * apps/api/src/routes/cost-analysis.ts — we send the asset's loads
 * + telemetry over a date window to Sonnet 4.5, force structured
 * output via a tool, and render the result as a per-load table.
 *
 * Default state is "click to run" because each call costs real money
 * (~5-10¢ at Sonnet pricing). Result isn't cached server-side — every
 * run is fresh against current data.
 */
'use client';

import { useEffect, useState } from 'react';
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import { railway, type CostAnalysisResult, type CostAnalysisLoad } from '@/lib/railway';

/** Safe number formatter — returns a placeholder for null/undefined/NaN/Infinity
 *  instead of throwing. Claude's tool input is usually schema-compliant but
 *  edge cases (divide-by-zero, missing fields) shouldn't crash the panel. */
function num(value: unknown, opts: { decimals?: number; prefix?: string; suffix?: string; placeholder?: string } = {}): string {
  const { decimals = 0, prefix = '', suffix = '', placeholder = '—' } = opts;
  if (typeof value !== 'number' || !Number.isFinite(value)) return placeholder;
  const formatted = decimals > 0 ? value.toFixed(decimals) : Math.round(value).toLocaleString();
  return `${prefix}${formatted}${suffix}`;
}

/** Numeric guard for color thresholds — treats non-finite as 0 so comparisons don't blow up. */
function safeNum(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function formatAgo(d: Date): string {
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60)        return 'just now';
  if (sec < 3600)      return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86_400)    return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86_400)}d ago`;
}

interface Props {
  vehicleId: number;
  /** Lookback window in days, mirrors the modal's range chip. */
  days: number;
}

export default function CostAnalysisPanel({ vehicleId, days }: Props) {
  const [loadingLatest, setLoadingLatest] = useState(true);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [result,  setResult]  = useState<CostAnalysisResult | null>(null);
  const [counts,  setCounts]  = useState<{ movements: number; loads: number } | null>(null);
  const [usage,   setUsage]   = useState<{ inputTokens?: number; outputTokens?: number } | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [ranWindow, setRanWindow] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  /** When running chunked analysis: how many loads we expect / completed. */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** Per-load results as they arrive — used to render rows progressively. */
  const [partialLoads, setPartialLoads] = useState<CostAnalysisLoad[]>([]);

  // Auto-load the most recent saved report for this vehicle so users
  // see prior work immediately and don't burn tokens on a fresh run
  // they didn't ask for.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingLatest(true);
      try {
        const { report } = await railway.getLatestCostAnalysis(vehicleId);
        if (cancelled || !report) return;
        setResult(report.result);
        setCounts(report.counts);
        setUsage(report.usage ?? null);
        setCreatedAt(report.created_at);
        setRanWindow(`${report.window_from.slice(0, 10)} → ${report.window_to.slice(0, 10)}`);
      } catch (e) {
        // Non-fatal — just means no cached report. The empty CTA shows.
        console.warn('[CostAnalysisPanel] latest fetch:', e);
      } finally {
        if (!cancelled) setLoadingLatest(false);
      }
    })();
    return () => { cancelled = true; };
  }, [vehicleId]);

  // Tick a per-second elapsed counter while a fresh run is in flight
  // so the long wait shows progress instead of looking frozen.
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);

  /** Chunked run: one HTTP call per load fires in parallel. Each
   *  resolves in ~15-30s and gets pushed to partialLoads so the UI
   *  shows progress. After all settle, summary is computed locally
   *  and the bundle is persisted via /save. */
  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setPartialLoads([]);
    setProgress(null);
    try {
      const nowMs   = Date.now();
      const fromIso = new Date(nowMs - days * 86_400_000).toISOString();
      const toIso   = new Date(nowMs).toISOString();

      // Step 1: get the list of loads to chunk against (cheap, no AI).
      const list = await railway.listCostAnalysisLoads(vehicleId, fromIso, toIso);
      const events = list.events ?? [];
      setProgress({ done: 0, total: events.length });

      if (events.length === 0) {
        // No loads in window — still want to show something useful.
        const emptyResult: CostAnalysisResult = {
          loads: [],
          unmatchedMovements: [],
          summary: {
            totalRevenue: 0, totalDriverPay: 0, totalMargin: 0,
            totalLoadedMiles: 0, totalDeadheadMiles: 0, totalReturnHomeMiles: 0,
            totalLoadedHours: 0, totalDeadheadHours: 0,
            fleetTrueRpm: 0, fleetTrueRph: 0, fleetMarginRpm: 0, fleetMarginRph: 0,
            loadedRatio: 0,
            narrative: `No loads found for this truck between ${fromIso.slice(0, 10)} and ${toIso.slice(0, 10)}.`,
          },
        };
        setResult(emptyResult);
        setCounts({ movements: list.movementsCount, loads: 0 });
        setRanWindow(`${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`);
        setUsage(null);
        setCreatedAt(null);
        return;
      }

      // Step 2: fire all per-load calls in parallel. Each that resolves
      // updates partialLoads + progress; failures are captured but
      // don't abort the rest.
      let totalIn = 0, totalOut = 0;
      const errors: string[] = [];
      const results = await Promise.allSettled(
        events.map(async (ev) => {
          const r = await railway.analyzeCostLoad(vehicleId, ev.id);
          totalIn  += r.usage.inputTokens  ?? 0;
          totalOut += r.usage.outputTokens ?? 0;
          const cleanedLoad: CostAnalysisLoad = {
            ...(r.load as Omit<CostAnalysisLoad, 'loadId'>),
            loadId: ev.id,
          };
          setPartialLoads(prev => [...prev, cleanedLoad]);
          setProgress(prev => prev ? { ...prev, done: prev.done + 1 } : prev);
          return cleanedLoad;
        }),
      );

      const succeeded: CostAnalysisLoad[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          succeeded.push(r.value);
        } else {
          const detail = r.reason instanceof Error ? r.reason.message : String(r.reason);
          errors.push(`Load ${events[i].title ?? events[i].id}: ${detail}`);
        }
      }

      // Sort by the event's start time so the table reads in
      // chronological order regardless of which calls resolved first.
      const orderByEvent = new Map(events.map((e, i) => [e.id, i]));
      succeeded.sort((a, b) => (orderByEvent.get(a.loadId) ?? 0) - (orderByEvent.get(b.loadId) ?? 0));

      // Step 3: compute the summary locally and assemble the final result.
      const summary = computeSummary(succeeded);
      const assembled: CostAnalysisResult = {
        loads: succeeded,
        unmatchedMovements: [], // chunked flow doesn't classify these for now
        summary: {
          ...summary,
          narrative: errors.length > 0
            ? `${succeeded.length} of ${events.length} loads analyzed successfully. ${errors.length} failed — re-run to retry.`
            : `${succeeded.length} load${succeeded.length === 1 ? '' : 's'} analyzed across ${list.movementsCount} movements in this window.`,
        },
      };

      setResult(assembled);
      setCounts({ movements: list.movementsCount, loads: events.length });
      setUsage({ inputTokens: totalIn, outputTokens: totalOut });
      setRanWindow(`${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`);

      // Step 4: persist the bundle. Non-blocking on failure.
      try {
        const saved = await railway.saveCostAnalysis({
          vehicleId,
          from: fromIso,
          to:   toIso,
          assetId: list.assetId ?? undefined,
          result: assembled,
          counts: { movements: list.movementsCount, loads: events.length },
          usage:  { inputTokens: totalIn, outputTokens: totalOut },
        });
        setCreatedAt(saved.createdAt);
      } catch (saveErr) {
        console.warn('[CostAnalysisPanel] save failed (result not persisted):', saveErr);
      }

      if (errors.length > 0) {
        setError(`Some loads failed:\n${errors.join('\n')}`);
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  /** Sum up the per-load rows into the summary stats the UI displays.
   *  Mirrors what the holistic prompt used to compute server-side. */
  function computeSummary(loads: CostAnalysisLoad[]): Omit<CostAnalysisResult['summary'], 'narrative'> {
    let revenue = 0, driverPay = 0, margin = 0;
    let loadedMi = 0, deadheadMi = 0;
    let loadedHr = 0, deadheadHr = 0;
    for (const l of loads) {
      revenue    += safeNum(l.revenue);
      driverPay  += safeNum(l.driverPay);
      margin     += safeNum(l.marginAfterDriver);
      loadedMi   += safeNum(l.loadedMiles);
      deadheadMi += safeNum(l.deadheadMilesBefore) + safeNum(l.deadheadMilesAfter);
      loadedHr   += safeNum(l.loadedHours);
      deadheadHr += safeNum(l.deadheadHoursBefore) + safeNum(l.deadheadHoursAfter);
    }
    const totalMi = loadedMi + deadheadMi;
    const totalHr = loadedHr + deadheadHr;
    return {
      totalRevenue:         revenue,
      totalDriverPay:       driverPay,
      totalMargin:          margin,
      totalLoadedMiles:     loadedMi,
      totalDeadheadMiles:   deadheadMi,
      totalReturnHomeMiles: 0,                                  // not separately tracked in chunked mode
      totalLoadedHours:     loadedHr,
      totalDeadheadHours:   deadheadHr,
      fleetTrueRpm:   totalMi > 0 ? revenue / totalMi : 0,
      fleetTrueRph:   totalHr > 0 ? revenue / totalHr : 0,
      fleetMarginRpm: totalMi > 0 ? margin  / totalMi : 0,
      fleetMarginRph: totalHr > 0 ? margin  / totalHr : 0,
      loadedRatio:    totalMi > 0 ? loadedMi / totalMi : 0,
    };
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          <Sparkles size={11} />
          <span>Experimental — Claude reasons about which movements belong to which loads, then reports true RPM including deadhead.</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {loadingLatest && !result && !running && (
          <div className="flex flex-col items-center justify-center py-10 gap-2">
            <Loader2 size={16} className="animate-spin" style={{ color: 'var(--gc-text-3)' }} />
            <p className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>Loading saved reports…</p>
          </div>
        )}

        {!loadingLatest && !result && !running && !error && (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <p className="text-[12px] max-w-md" style={{ color: 'var(--gc-text-3)' }}>
              No saved analysis yet for this truck. Sends the last {days} day{days === 1 ? '' : 's'} of movements + scheduled loads to Claude
              and asks it to match them. Costs a few cents per run, takes 1-3 minutes. The result is saved so you don&apos;t pay to re-open the tab.
            </p>
            <button
              onClick={handleRun}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors"
              style={{ background: 'var(--gc-blue)' }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
            >
              <Sparkles size={14} />
              Run analysis
            </button>
          </div>
        )}

        {running && (
          <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
              {progress
                ? <>Analyzing load <strong className="tabular-nums">{progress.done}</strong> of <strong className="tabular-nums">{progress.total}</strong>… <span className="tabular-nums">({elapsed}s)</span></>
                : <>Looking up loads in window… <span className="tabular-nums">({elapsed}s)</span></>}
            </p>
            <p className="text-[11px] max-w-md" style={{ color: 'var(--gc-text-3)' }}>
              Per-load calls fire in parallel — total time is about the slowest load (~30s), not the sum. Each load lights up below as it finishes.
            </p>
            {/* Per-load results stream in as the analysis runs */}
            {partialLoads.length > 0 && (
              <div className="w-full mt-2 max-h-64 overflow-y-auto rounded-lg" style={{ border: '1px solid var(--gc-border-light)' }}>
                {partialLoads.map((l, i) => (
                  <div key={l.loadId ?? i} className="px-3 py-1.5 text-[11px] text-left flex items-center gap-2"
                    style={{ borderTop: i > 0 ? '1px solid var(--gc-border-light)' : 'none' }}>
                    <span style={{ color: 'var(--gc-text-3)' }}>✓</span>
                    <span style={{ color: 'var(--gc-text-1)', flex: 1 }}>{l.loadLabel ?? '(load)'}</span>
                    <span className="tabular-nums" style={{ color: 'var(--gc-text-3)' }}>
                      {num(l.revenue, { prefix: '$' })} · <span style={{ color: safeNum(l.trueRpm) < safeNum(l.statedRpm) * 0.8 ? '#d93025' : 'var(--gc-text-2)' }}>{num(l.trueRpm, { decimals: 2, prefix: '$' })}/mi true</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && !running && (
          <div className="flex flex-col items-start py-4 gap-2 rounded-lg px-3 py-3"
            style={{ background: 'rgba(217,48,37,0.06)', border: '1px solid rgba(217,48,37,0.25)' }}>
            <div className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: '#d93025' }}>
              <AlertTriangle size={12} /> Analysis failed
            </div>
            <p className="text-[11px]" style={{ color: '#7a1d18' }}>{error}</p>
            <button
              onClick={handleRun}
              className="text-[11px] font-medium mt-1"
              style={{ color: 'var(--gc-blue)' }}
            >
              Retry
            </button>
          </div>
        )}

        {result && !running && (
          <ResultView
            result={result}
            counts={counts}
            usage={usage}
            ranWindow={ranWindow}
            createdAt={createdAt}
            onRerun={handleRun}
          />
        )}
      </div>
    </div>
  );
}

function ResultView({ result, counts, usage, ranWindow, createdAt, onRerun }: {
  result: CostAnalysisResult;
  counts: { movements: number; loads: number } | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  ranWindow: string | null;
  createdAt: string | null;
  onRerun: () => void;
}) {
  const s = result.summary;
  const generatedAgo = createdAt ? formatAgo(new Date(createdAt)) : null;
  return (
    <div className="flex flex-col gap-4">
      {/* Top: window + re-run + meta */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          Window: <span style={{ color: 'var(--gc-text-2)' }}>{ranWindow}</span>
          {counts && <span> · {counts.loads} load{counts.loads === 1 ? '' : 's'} · {counts.movements} movement{counts.movements === 1 ? '' : 's'}</span>}
          {generatedAgo && <span> · generated {generatedAgo}</span>}
          {usage?.inputTokens != null && <span> · {usage.inputTokens.toLocaleString()} in · {usage.outputTokens?.toLocaleString() ?? '?'} out</span>}
        </div>
        <button onClick={onRerun} className="text-[11px] font-medium" style={{ color: 'var(--gc-blue)' }}>
          Re-run
        </button>
      </div>

      {/* Summary block */}
      <div className="rounded-lg p-3" style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
        {/* Top row: revenue & margin */}
        <div className="grid grid-cols-4 gap-3 mb-3">
          <Stat label="Revenue"             value={num(s.totalRevenue,   { prefix: '$' })} />
          <Stat label="Driver pay"          value={num(s.totalDriverPay, { prefix: '$' })} />
          <Stat label="Margin after driver" value={num(s.totalMargin,    { prefix: '$' })} accent={safeNum(s.totalMargin) >= 0} negative={safeNum(s.totalMargin) < 0} />
          <Stat label="Loaded ratio"        value={Number.isFinite(s.loadedRatio) ? `${Math.round(s.loadedRatio * 100)}%` : '—'} />
        </div>
        {/* Middle row: miles + hours */}
        <div className="grid grid-cols-4 gap-3 mb-3 pt-3" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
          <Stat label="Loaded mi"  value={num(s.totalLoadedMiles)} />
          <Stat label="Empty mi"   value={num(safeNum(s.totalDeadheadMiles) + safeNum(s.totalReturnHomeMiles))} />
          <Stat label="Loaded hrs" value={num(s.totalLoadedHours, { decimals: 1 })} />
          <Stat label="Empty hrs"  value={num(s.totalDeadheadHours, { decimals: 1 })} />
        </div>
        {/* Bottom row: rates */}
        <div className="grid grid-cols-4 gap-3 pt-3" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
          <Stat label="True $/mi"   value={num(s.fleetTrueRpm, { decimals: 2, prefix: '$' })} accent />
          <Stat label="True $/hr"   value={num(s.fleetTrueRph, { decimals: 2, prefix: '$' })} accent />
          <Stat label="Margin $/mi" value={num(s.fleetMarginRpm, { decimals: 2, prefix: '$' })} accent={safeNum(s.fleetMarginRpm) >= 0} negative={safeNum(s.fleetMarginRpm) < 0} />
          <Stat label="Margin $/hr" value={num(s.fleetMarginRph, { decimals: 2, prefix: '$' })} accent={safeNum(s.fleetMarginRph) >= 0} negative={safeNum(s.fleetMarginRph) < 0} />
        </div>
        <div className="text-[11px] leading-relaxed pt-3 mt-1" style={{ color: 'var(--gc-text-2)', borderTop: '1px dashed var(--gc-border-light)' }}>
          {s.narrative ?? '(no narrative returned)'}
        </div>
      </div>

      {/* Per-load table — scrolls horizontally only if even the
          expanded modal isn't wide enough. */}
      <div className="rounded-lg overflow-auto" style={{ border: '1px solid var(--gc-border-light)' }}>
        <table className="w-full text-[12px]" style={{ minWidth: 1100 }}>
          <thead>
            <tr style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-3)' }}>
              <th className="text-left  px-2 py-1.5 font-semibold sticky left-0 z-10" style={{ background: 'var(--gc-bg)' }}>Load</th>
              <th className="text-right px-2 py-1.5 font-semibold">Rev</th>
              <th className="text-right px-2 py-1.5 font-semibold">Driver</th>
              <th className="text-right px-2 py-1.5 font-semibold">Margin</th>
              <th className="text-right px-2 py-1.5 font-semibold">Loaded mi</th>
              <th className="text-right px-2 py-1.5 font-semibold">Empty mi</th>
              <th className="text-right px-2 py-1.5 font-semibold">Loaded hr</th>
              <th className="text-right px-2 py-1.5 font-semibold">Empty hr</th>
              <th className="text-right px-2 py-1.5 font-semibold">Stated $/mi</th>
              <th className="text-right px-2 py-1.5 font-semibold">True $/mi</th>
              <th className="text-right px-2 py-1.5 font-semibold">True $/hr</th>
              <th className="text-right px-2 py-1.5 font-semibold">Mgn $/mi</th>
              <th className="text-center px-2 py-1.5 font-semibold">Conf</th>
            </tr>
          </thead>
          <tbody>
            {result.loads.length === 0 && (
              <tr>
                <td colSpan={13} className="text-center px-2 py-4" style={{ color: 'var(--gc-text-3)' }}>
                  No loads matched in this window.
                </td>
              </tr>
            )}
            {result.loads.map((l) => {
              const totalEmptyMi = safeNum(l.deadheadMilesBefore) + safeNum(l.deadheadMilesAfter);
              const totalEmptyHr = safeNum(l.deadheadHoursBefore) + safeNum(l.deadheadHoursAfter);
              const stated       = safeNum(l.statedRpm);
              const trueR        = safeNum(l.trueRpm);
              const trueRpmCrash = stated > 0 && trueR > 0 && trueR < stated * 0.8;
              const marginNeg    = safeNum(l.marginAfterDriver) < 0;
              return (
                <tr key={l.loadId} style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                  <td className="px-2 py-1.5 font-medium sticky left-0 z-10" style={{ color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}>
                    {l.loadLabel ?? '(unlabeled)'}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(l.revenue,           { prefix: '$' })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{num(l.driverPay, { prefix: '$' })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{ color: marginNeg ? '#d93025' : 'var(--gc-text-1)' }}>
                    {num(l.marginAfterDriver, { prefix: '$' })}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(l.loadedMiles)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{num(totalEmptyMi)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(l.loadedHours, { decimals: 1 })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{num(totalEmptyHr, { decimals: 1 })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(l.statedRpm, { decimals: 2, prefix: '$' })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{ color: trueRpmCrash ? '#d93025' : 'var(--gc-text-1)' }}>
                    {num(l.trueRpm, { decimals: 2, prefix: '$' })}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{num(l.trueRph, { decimals: 2, prefix: '$' })}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums"
                    style={{ color: safeNum(l.marginRpm) < 0 ? '#d93025' : 'var(--gc-text-1)' }}>
                    {num(l.marginRpm, { decimals: 2, prefix: '$' })}
                  </td>
                  <td className="px-2 py-1.5 text-center"><ConfidenceChip level={l.confidence} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Per-load reasoning */}
      {result.loads.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
            How matches were made
          </div>
          {result.loads.map(l => (
            <div key={l.loadId} className="rounded-lg px-3 py-2 text-[11px] leading-relaxed"
              style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)' }}>
              <div className="font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>{l.loadLabel}</div>
              <div style={{ color: 'var(--gc-text-2)' }}>{l.reasoning}</div>
            </div>
          ))}
        </div>
      )}

      {/* Unmatched movements */}
      {result.unmatchedMovements.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--gc-text-3)' }}>
            Movements not tied to a load ({result.unmatchedMovements.length})
          </div>
          <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
            {result.unmatchedMovements.map((u, i) => (
              <div key={u.movementId} className="px-3 py-1.5 text-[11px]"
                style={{ borderTop: i > 0 ? '1px solid var(--gc-border-light)' : 'none' }}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono" style={{ color: 'var(--gc-text-3)' }}>M{u.movementId}</span>
                  <span style={{ color: 'var(--gc-text-2)' }}>
                    {num(u.miles)} mi · <span style={{ color: 'var(--gc-text-1)' }}>{(u.likelyPurpose ?? 'unknown').replace(/_/g, ' ')}</span>
                  </span>
                </div>
                <div className="mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{u.reasoning ?? ''}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, accent, negative }: { label: string; value: string; accent?: boolean; negative?: boolean }) {
  const color = negative ? '#d93025' : accent ? 'var(--gc-blue)' : 'var(--gc-text-1)';
  return (
    <div className="flex flex-col">
      <span style={{ color: 'var(--gc-text-3)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{label}</span>
      <span style={{ color, fontWeight: 700, fontSize: 16 }}>{value}</span>
    </div>
  );
}

function ConfidenceChip({ level }: { level: 'high' | 'medium' | 'low' }) {
  const colors = {
    high:   { bg: '#dcfce7', fg: '#166534' },
    medium: { bg: '#fef3c7', fg: '#92400e' },
    low:    { bg: '#fee2e2', fg: '#991b1b' },
  }[level];
  return (
    <span className="inline-block text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded"
      style={{ background: colors.bg, color: colors.fg }}>
      {level}
    </span>
  );
}
