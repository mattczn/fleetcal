'use client';

/**
 * Live operational pulse for /admin.
 *
 * Polls /api/admin/pulse every 60s. The endpoint is cheap (Sentry
 * data is cached for 5 minutes upstream; cron + AI numbers are
 * sub-second indexed reads), but 60s is the user-perceived
 * freshness — anything tighter is wasted server work for a
 * dashboard you mostly glance at.
 *
 * Each row degrades to "—" when the upstream returns null. We
 * never render an error state for missing data; the goal is to
 * keep the admin page useful even if Sentry is down.
 */

import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, Clock, DollarSign, GitCommit, Users } from 'lucide-react';

interface PulsePayload {
  generatedAt: string;
  errors24h:   { count: number; prevCount: number; affectedUsers: number } | null;
  release:     { version: string; dateCreated: string } | null;
  crons:       {
    healthy:         number;
    failingNow:      number;
    silent:          number;
    total:           number;
    failuresLast24h: number;
  };
  aiSpend24h:  number | null;
  aiCalls24h:  number | null;
}

export default function PulseCard() {
  const [data,    setData]    = useState<PulsePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [stale,   setStale]   = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/admin/pulse', { cache: 'no-store' });
        if (!res.ok) {
          if (!cancelled) setStale(true);
          return;
        }
        const json = (await res.json()) as PulsePayload;
        if (!cancelled) {
          setData(json);
          setStale(false);
        }
      } catch {
        if (!cancelled) setStale(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const errorsDelta = data?.errors24h
    ? data.errors24h.count - data.errors24h.prevCount
    : 0;

  return (
    <div
      className="rounded-xl"
      style={{
        background: 'var(--gc-surface)',
        border:     '1px solid var(--gc-border-light)',
        boxShadow:  'var(--shadow-1)',
        padding:    '20px',
      }}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-[15px] font-bold" style={{ color: 'var(--gc-text-1)' }}>
            Live pulse
          </span>
          <PulseDot stale={stale || !data} />
        </div>
        <div className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
          {loading && !data ? 'Loading…' : data ? `Updated ${formatAgo(data.generatedAt)}` : 'Unavailable'}
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <PulseTile
          icon={<AlertTriangle size={14} />}
          label="Errors (24h)"
          value={data?.errors24h ? data.errors24h.count.toString() : '—'}
          delta={data?.errors24h ? errorsDelta : null}
          deltaInvert
          tone={data?.errors24h && data.errors24h.count > 0 ? 'warn' : 'ok'} />
        <PulseTile
          icon={<Users size={14} />}
          label="Affected users (24h)"
          value={data?.errors24h ? data.errors24h.affectedUsers.toString() : '—'}
          tone={data?.errors24h && data.errors24h.affectedUsers > 0 ? 'warn' : 'ok'} />
        <PulseTile
          icon={<Activity size={14} />}
          label="Cron health"
          value={data ? `${data.crons.healthy}/${data.crons.total}` : '—'}
          subtext={data && data.crons.failingNow + data.crons.silent > 0
            ? `${data.crons.failingNow} failing · ${data.crons.silent} silent`
            : data && data.crons.failuresLast24h > 0
              ? `${data.crons.failuresLast24h} fails (recovered)`
              : 'all green'}
          tone={
            !data
              ? 'neutral'
              : data.crons.failingNow + data.crons.silent > 0
                ? 'error'
                : data.crons.failuresLast24h > 0
                  ? 'warn'
                  : 'ok'
          } />
        <PulseTile
          icon={<DollarSign size={14} />}
          label="AI spend (24h)"
          value={data?.aiSpend24h == null ? '—' : `$${data.aiSpend24h.toFixed(2)}`}
          subtext={data?.aiCalls24h == null ? undefined : `${data.aiCalls24h} calls`}
          tone="neutral" />
        <PulseTile
          icon={<GitCommit size={14} />}
          label="Last deploy"
          value={data?.release ? formatAgo(data.release.dateCreated) : '—'}
          subtext={data?.release ? shortVersion(data.release.version) : undefined}
          tone="neutral" />
        <PulseTile
          icon={<Clock size={14} />}
          label="Now"
          value={data ? new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—'}
          tone="neutral" />
      </div>

      {data && (data.crons.failingNow > 0 || data.crons.silent > 0) && (
        <div
          className="mt-3 text-[12px] flex items-center gap-2 px-3 py-2 rounded-md"
          style={{ background: '#fef7e0', color: '#b06000' }}>
          <AlertTriangle size={14} />
          Cron heartbeat issue — see <a href="/admin/health" className="underline">Operational health</a> for details.
        </div>
      )}

      {/* Inline keyframes for the heartbeat dot — kept local so no
          dependency on a global CSS file. */}
      <style>{`
        @keyframes pulse-fade {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.45; transform: scale(0.85); }
        }
      `}</style>
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────

function PulseDot({ stale }: { stale: boolean }) {
  return (
    <span style={{
      display:      'inline-block',
      width:        8,
      height:       8,
      borderRadius: '50%',
      background:   stale ? '#9aa0a6' : '#34a853',
      // pulse keyframes — defined inline so we don't need a CSS file
      animation:    stale ? undefined : 'pulse-fade 2s ease-in-out infinite',
    }} />
  );
}

type Tone = 'ok' | 'warn' | 'error' | 'neutral';

function PulseTile({
  icon, label, value, subtext, delta, deltaInvert, tone,
}: {
  icon:        React.ReactNode;
  label:       string;
  value:       string;
  subtext?:    string;
  /** Numeric change vs prior window; null hides the chip. */
  delta?:      number | null;
  /** When true, positive delta is RED (more bugs is bad). */
  deltaInvert?: boolean;
  tone:        Tone;
}) {
  const toneStyles = TONE_STYLES[tone];
  const deltaSign  = delta != null && delta > 0 ? '+' : '';
  const deltaColor = delta == null || delta === 0
    ? '#5f6368'
    : deltaInvert
      ? (delta > 0 ? '#c5221f' : '#137333')
      : (delta > 0 ? '#137333' : '#c5221f');

  return (
    <div style={{
      background:   toneStyles.bg,
      border:       `1px solid ${toneStyles.border}`,
      borderRadius: 10,
      padding:      '12px 14px',
      minHeight:    74,
    }}>
      <div className="flex items-center gap-1.5" style={{ color: toneStyles.label }}>
        <span style={{ display: 'inline-flex' }}>{icon}</span>
        <span className="text-[11px] font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className="text-[20px] font-bold" style={{ color: toneStyles.value }}>{value}</span>
        {delta != null && delta !== 0 && (
          <span className="text-[11px] font-semibold" style={{ color: deltaColor }}>
            {deltaSign}{delta}
          </span>
        )}
      </div>
      {subtext && (
        <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>{subtext}</div>
      )}
    </div>
  );
}

const TONE_STYLES: Record<Tone, { bg: string; border: string; label: string; value: string }> = {
  ok:      { bg: '#e6f4ea', border: '#ceead6', label: '#137333', value: '#0b6e2e' },
  warn:    { bg: '#fef7e0', border: '#fce8b2', label: '#b06000', value: '#8a4b00' },
  error:   { bg: '#fce8e6', border: '#f5c2c0', label: '#c5221f', value: '#9c1c19' },
  neutral: { bg: 'var(--gc-surface-2, #f8f9fa)', border: 'var(--gc-border-light)', label: 'var(--gc-text-3)', value: 'var(--gc-text-1)' },
};

// ─── Helpers ───────────────────────────────────────────────────────

function formatAgo(iso: string): string {
  const now  = Date.now();
  const then = new Date(iso).getTime();
  const secs = Math.max(0, Math.floor((now - then) / 1000));
  if (secs < 60)     return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60)     return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24)    return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function shortVersion(version: string): string {
  // Sentry release versions are often long commit SHAs or
  // "package@sha" strings. Show first 7 chars of whatever
  // looks like a SHA, or trim a long string to 16 chars.
  const trimmed = version.includes('@') ? version.split('@')[1] : version;
  if (/^[a-f0-9]{7,}$/i.test(trimmed)) return trimmed.slice(0, 7);
  return trimmed.length > 16 ? `${trimmed.slice(0, 13)}…` : trimmed;
}
