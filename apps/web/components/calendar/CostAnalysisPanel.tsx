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

import { useState } from 'react';
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import { railway, type CostAnalysisResult } from '@/lib/railway';

interface Props {
  vehicleId: number;
  /** Lookback window in days, mirrors the modal's range chip. */
  days: number;
}

export default function CostAnalysisPanel({ vehicleId, days }: Props) {
  const [running, setRunning] = useState(false);
  const [result,  setResult]  = useState<CostAnalysisResult | null>(null);
  const [counts,  setCounts]  = useState<{ movements: number; loads: number } | null>(null);
  const [usage,   setUsage]   = useState<{ inputTokens?: number; outputTokens?: number } | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [ranWindow, setRanWindow] = useState<string | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const nowMs = Date.now();
      const fromIso = new Date(nowMs - days * 86_400_000).toISOString();
      const toIso   = new Date(nowMs).toISOString();
      const r = await railway.getCostAnalysis(vehicleId, fromIso, toIso);
      setResult(r.analysis);
      setCounts(r.counts);
      setUsage(r.usage);
      setRanWindow(`${fromIso.slice(0, 10)} → ${toIso.slice(0, 10)}`);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail);
    } finally {
      setRunning(false);
    }
  };

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
        {!result && !running && !error && (
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <p className="text-[12px] max-w-md" style={{ color: 'var(--gc-text-3)' }}>
              Sends the last {days} day{days === 1 ? '' : 's'} of this truck&apos;s movements + scheduled loads to Claude and asks it to match them.
              Click below to run. Each call costs a few cents and takes 10-20 seconds.
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
          <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--gc-blue)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
              Claude is reasoning through the route…
            </p>
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
            onRerun={handleRun}
          />
        )}
      </div>
    </div>
  );
}

function ResultView({ result, counts, usage, ranWindow, onRerun }: {
  result: CostAnalysisResult;
  counts: { movements: number; loads: number } | null;
  usage: { inputTokens?: number; outputTokens?: number } | null;
  ranWindow: string | null;
  onRerun: () => void;
}) {
  const s = result.summary;
  return (
    <div className="flex flex-col gap-4">
      {/* Top: window + re-run + meta */}
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          Window: <span style={{ color: 'var(--gc-text-2)' }}>{ranWindow}</span>
          {counts && <span> · {counts.loads} load{counts.loads === 1 ? '' : 's'} · {counts.movements} movement{counts.movements === 1 ? '' : 's'}</span>}
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
          <Stat label="Revenue"          value={`$${Math.round(s.totalRevenue).toLocaleString()}`} />
          <Stat label="Driver pay"       value={`$${Math.round(s.totalDriverPay).toLocaleString()}`} />
          <Stat label="Margin after driver" value={`$${Math.round(s.totalMargin).toLocaleString()}`} accent={s.totalMargin >= 0} negative={s.totalMargin < 0} />
          <Stat label="Loaded ratio"     value={`${Math.round(s.loadedRatio * 100)}%`} />
        </div>
        {/* Middle row: miles + hours */}
        <div className="grid grid-cols-4 gap-3 mb-3 pt-3" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
          <Stat label="Loaded mi"  value={Math.round(s.totalLoadedMiles).toLocaleString()} />
          <Stat label="Empty mi"   value={Math.round(s.totalDeadheadMiles + s.totalReturnHomeMiles).toLocaleString()} />
          <Stat label="Loaded hrs" value={s.totalLoadedHours.toFixed(1)} />
          <Stat label="Empty hrs"  value={s.totalDeadheadHours.toFixed(1)} />
        </div>
        {/* Bottom row: rates */}
        <div className="grid grid-cols-4 gap-3 pt-3" style={{ borderTop: '1px dashed var(--gc-border-light)' }}>
          <Stat label="True $/mi"   value={`$${s.fleetTrueRpm.toFixed(2)}`} accent />
          <Stat label="True $/hr"   value={`$${s.fleetTrueRph.toFixed(2)}`} accent />
          <Stat label="Margin $/mi" value={`$${s.fleetMarginRpm.toFixed(2)}`} accent={s.fleetMarginRpm >= 0} negative={s.fleetMarginRpm < 0} />
          <Stat label="Margin $/hr" value={`$${s.fleetMarginRph.toFixed(2)}`} accent={s.fleetMarginRph >= 0} negative={s.fleetMarginRph < 0} />
        </div>
        <div className="text-[11px] leading-relaxed pt-3 mt-1" style={{ color: 'var(--gc-text-2)', borderTop: '1px dashed var(--gc-border-light)' }}>
          {s.narrative}
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
              const totalEmptyMi = l.deadheadMilesBefore + l.deadheadMilesAfter;
              const totalEmptyHr = l.deadheadHoursBefore + l.deadheadHoursAfter;
              const trueRpmCrash = l.trueRpm < l.statedRpm * 0.8;
              const marginNeg    = l.marginAfterDriver < 0;
              return (
                <tr key={l.loadId} style={{ borderTop: '1px solid var(--gc-border-light)' }}>
                  <td className="px-2 py-1.5 font-medium sticky left-0 z-10" style={{ color: 'var(--gc-text-1)', background: 'var(--gc-surface)' }}>
                    {l.loadLabel}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">${Math.round(l.revenue).toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>${Math.round(l.driverPay).toLocaleString()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{ color: marginNeg ? '#d93025' : 'var(--gc-text-1)' }}>
                    ${Math.round(l.marginAfterDriver).toLocaleString()}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{Math.round(l.loadedMiles)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{Math.round(totalEmptyMi)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{l.loadedHours.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums" style={{ color: 'var(--gc-text-3)' }}>{totalEmptyHr.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">${l.statedRpm.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums font-semibold"
                    style={{ color: trueRpmCrash ? '#d93025' : 'var(--gc-text-1)' }}>
                    ${l.trueRpm.toFixed(2)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">${l.trueRph.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums"
                    style={{ color: l.marginRpm < 0 ? '#d93025' : 'var(--gc-text-1)' }}>
                    ${l.marginRpm.toFixed(2)}
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
                    {u.miles.toFixed(0)} mi · <span style={{ color: 'var(--gc-text-1)' }}>{u.likelyPurpose.replace(/_/g, ' ')}</span>
                  </span>
                </div>
                <div className="mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{u.reasoning}</div>
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
