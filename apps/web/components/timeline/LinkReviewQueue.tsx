'use client';

/**
 * /timeline/review — loads whose GPS doesn't line up with the calendar,
 * across the fleet. Each row opens the truck's timeline on that day with
 * the load selected, where the GPS check, the verdict buttons and the link
 * editor live. See docs/movement-linking.md.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, MapPin } from 'lucide-react';
import type { LinkReviewItem, LinkReviewListResponse } from '@fleetcal/types';
import AppShell from '@/components/nav/AppShell';
import { railway } from '@/lib/railway';
import { useCalendarStore } from '@/store/useCalendarStore';
import { CONFIDENCE_STYLE, ISSUE_LABEL } from './LegCheckPanel';

type Scope = 'review' | 'low' | 'medium' | 'all';
const SCOPE_LABEL: Record<Scope, string> = { review: 'Needs a look', low: 'Low only', medium: 'Medium only', all: 'All loads' };
const SCOPE_CONFIDENCE: Record<Scope, string> = { review: 'low,medium', low: 'low', medium: 'medium', all: '' };

function dayKeyInTz(d: Date, tz: string): string {
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}
function shiftDay(key: string, days: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default function LinkReviewQueue() {
  const { calendarTimezone } = useCalendarStore();
  const tz = calendarTimezone || 'America/Denver';
  const today = dayKeyInTz(new Date(), tz);

  const [from, setFrom] = useState(() => shiftDay(today, -14));
  const [to, setTo] = useState(today);
  const [scope, setScope] = useState<Scope>('review');
  const [issue, setIssue] = useState('');
  const [truck, setTruck] = useState('');
  const [unreviewed, setUnreviewed] = useState(true);
  // Each response is tagged with the filters it answers, so "loading" is
  // just "the latest answer is for older filters".
  const queryKey = JSON.stringify({ from, to, scope, issue, unreviewed });
  const [result, setResult] = useState<{ key: string; data?: LinkReviewListResponse; error?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    railway.getLinkReview({ from, to, confidence: SCOPE_CONFIDENCE[scope], issue: issue || undefined, unreviewed })
      .then((res) => { if (!cancelled) setResult({ key: queryKey, data: res }); })
      .catch((e) => { if (!cancelled) setResult({ key: queryKey, error: e instanceof Error ? e.message : 'Failed to load' }); });
    return () => { cancelled = true; };
  }, [queryKey, from, to, scope, issue, unreviewed]);
  const loading = result?.key !== queryKey;
  const data = result?.data ?? null;
  const error = !loading ? result?.error ?? null : null;

  const trucks = useMemo(
    () => Array.from(new Set((data?.items ?? []).map((i) => i.truck).filter((t): t is string => !!t))).sort(),
    [data],
  );
  const rows = useMemo(
    () => (data?.items ?? []).filter((i) => !truck || i.truck === truck),
    [data, truck],
  );

  const field = { border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)' } as const;
  const counts = data?.counts;
  const total = counts ? counts.byConfidence.high + counts.byConfidence.medium + counts.byConfidence.low : 0;

  return (
    <AppShell>
      <div className="max-w-[1500px] mx-auto px-6 py-4">
        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <Link href="/timeline"
            className="w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}
            title="Back to the truck timeline">
            <ArrowLeft size={16} />
          </Link>
          <MapPin size={20} style={{ color: 'var(--gc-text-1)' }} />
          <h1 className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.3px' }}>
            GPS Review
          </h1>
          <div className="flex items-center gap-1.5 ml-2 text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
            <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className="rounded px-2 py-1" style={field} />
            <span>to</span>
            <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className="rounded px-2 py-1" style={field} />
          </div>
          <select value={scope} onChange={(e) => setScope(e.target.value as Scope)} className="rounded px-2 py-1 text-[12px]" style={field}>
            {(Object.keys(SCOPE_LABEL) as Scope[]).map((s) => <option key={s} value={s}>{SCOPE_LABEL[s]}</option>)}
          </select>
          <select value={issue} onChange={(e) => setIssue(e.target.value)} className="rounded px-2 py-1 text-[12px]" style={field}>
            <option value="">Any issue</option>
            {Object.entries(counts?.byIssue ?? {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => (
              <option key={k} value={k}>{ISSUE_LABEL[k] ?? k} ({n})</option>
            ))}
          </select>
          <select value={truck} onChange={(e) => setTruck(e.target.value)} className="rounded px-2 py-1 text-[12px]" style={field}>
            <option value="">All trucks</option>
            {trucks.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--gc-text-2)' }}>
            <input type="checkbox" checked={unreviewed} onChange={(e) => setUnreviewed(e.target.checked)} />
            Not reviewed yet
          </label>
        </div>

        {counts ? (
          <div className="flex items-center gap-3 mb-3 text-[12px] flex-wrap" style={{ color: 'var(--gc-text-2)' }}>
            <span>{total.toLocaleString()} loads checked</span>
            {(['high', 'medium', 'low'] as const).map((c) => (
              <span key={c} className="px-1.5 py-0.5 rounded font-semibold" style={{ background: CONFIDENCE_STYLE[c].bg, color: CONFIDENCE_STYLE[c].fg }}>
                {CONFIDENCE_STYLE[c].label} {counts.byConfidence[c]}
              </span>
            ))}
            <span>· {counts.reviewed} reviewed</span>
            {!data?.reviewsAvailable ? (
              <span style={{ color: '#b06000' }}>· Verdicts can&apos;t be saved until the link_reviews migration has been run.</span>
            ) : null}
          </div>
        ) : null}

        {error ? (
          <div className="p-4 rounded text-[13px]" style={{ background: '#fce8e6', color: '#c5221f' }}>{error}</div>
        ) : loading && !data ? (
          <div className="flex items-center gap-2 p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>Nothing to review for these filters.</div>
        ) : (
          <div className="rounded-lg overflow-x-auto" style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wider" style={{ color: 'var(--gc-text-3)', borderBottom: '1px solid var(--gc-border)' }}>
                  <th className="px-3 py-2 font-semibold">Date</th>
                  <th className="px-3 py-2 font-semibold">Load</th>
                  <th className="px-3 py-2 font-semibold">Truck</th>
                  <th className="px-3 py-2 font-semibold">Driver</th>
                  <th className="px-3 py-2 font-semibold">What&apos;s off</th>
                  <th className="px-3 py-2 font-semibold text-right">GPS / route mi</th>
                  <th className="px-3 py-2 font-semibold">Check</th>
                  <th className="px-3 py-2 font-semibold">Review</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => <Row key={r.eventId} r={r} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Row({ r }: { r: LinkReviewItem }) {
  const conf = CONFIDENCE_STYLE[r.confidence];
  const href = r.assetId != null
    ? `/timeline?assetId=${r.assetId}&date=${r.start.slice(0, 10)}&event=${r.eventId}`
    : null;
  const when = new Date(`${r.start.slice(0, 16)}:00`).toLocaleString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const cell = 'px-3 py-2 align-top';
  return (
    <tr style={{ borderBottom: '1px solid var(--gc-border)' }}>
      <td className={`${cell} tabular-nums whitespace-nowrap`} style={{ color: 'var(--gc-text-2)' }}>{when}</td>
      <td className={cell}>
        {href
          ? <Link href={href} className="font-semibold" style={{ color: 'var(--gc-blue)' }}>#{r.loadNum ?? '—'}</Link>
          : <span className="font-semibold">#{r.loadNum ?? '—'}</span>}
        {!r.revenue ? <span className="ml-1 text-[11px]" style={{ color: 'var(--gc-text-3)' }}>non-revenue</span> : null}
      </td>
      <td className={cell} style={{ color: 'var(--gc-text-1)' }}>{r.truck ?? '—'}</td>
      <td className={cell} style={{ color: 'var(--gc-text-2)' }}>{r.driverName ?? '—'}</td>
      <td className={cell}>
        <div className="flex flex-wrap gap-1">
          {r.issues.map((i) => (
            <span key={i} className="px-1.5 py-0.5 rounded text-[11px]" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)' }}>
              {ISSUE_LABEL[i] ?? i}
            </span>
          ))}
          {r.stops.some((s) => s.otherTrucks.length === 1) ? (
            <span className="px-1.5 py-0.5 rounded text-[11px]" style={{ background: '#fef7e0', color: '#b06000' }}>
              {r.stops.find((s) => s.otherTrucks.length === 1)!.otherTrucks[0].name} was there
            </span>
          ) : null}
        </div>
      </td>
      <td className={`${cell} text-right tabular-nums`} style={{ color: 'var(--gc-text-2)' }}>
        {r.loadedMiles != null ? Math.round(r.loadedMiles) : '—'} / {r.routeMiles != null ? Math.round(r.routeMiles) : '—'}
      </td>
      <td className={cell}>
        <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold" style={{ background: conf.bg, color: conf.fg }}>{conf.label}</span>
      </td>
      <td className={cell} style={{ fontSize: 12 }}>
        {r.review
          ? <span style={{ color: r.review.verdict === 'correct' ? '#1e8e3e' : '#c5221f' }}>{r.review.verdict === 'correct' ? 'Right' : 'Wrong'}</span>
          : r.ai?.suggestion
            ? <span style={{ color: 'var(--gc-text-3)' }}>AI: {r.ai.suggestion.cause.replace(/_/g, ' ')}</span>
            : <span style={{ color: 'var(--gc-text-3)' }}>—</span>}
      </td>
    </tr>
  );
}
