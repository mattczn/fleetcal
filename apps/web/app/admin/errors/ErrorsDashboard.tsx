'use client';

/**
 * /admin/errors dashboard.
 *
 * Tail of every 4xx/5xx API response captured by the Hono
 * captureErrors middleware. Filterable by status family, time
 * window, org, method, path substring. Click a row → drawer
 * showing the full body snippet + user-agent + duration.
 *
 * Auto-refreshes every 30s when the tab is foregrounded so you can
 * leave it open during a release and see new errors appear.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '@/components/nav/AppShell';
import { AlertOctagon, RefreshCw, X } from 'lucide-react';
import Link from 'next/link';
import Breadcrumbs from '../Breadcrumbs';

interface ErrorRow {
  id:           string;
  occurred_at:  string;
  org_id:       string | null;
  user_id:      string | null;
  method:       string;
  path:         string;
  status:       number;
  error_code:   string | null;
  detail:       string | null;
  body_snippet: string | null;
  user_agent:   string | null;
  duration_ms:  number | null;
}

interface ApiResp {
  rows:          ErrorRow[];
  totalMatching: number;
  window:        string;
  headline: {
    count4xx: number;
    count5xx: number;
    topEndpoints: Array<{ path: string; count: number }>;
  };
}

type StatusFamily = '' | '4xx' | '5xx';
type SinceKey     = '1h' | '24h' | '7d' | '30d';

export default function ErrorsDashboard() {
  const [statusFamily, setStatusFamily] = useState<StatusFamily>('');
  const [since, setSince]               = useState<SinceKey>('24h');
  const [orgFilter, setOrgFilter]       = useState('');
  const [pathFilter, setPathFilter]     = useState('');
  const [methodFilter, setMethodFilter] = useState('');
  const [data, setData] = useState<ApiResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]   = useState<string | null>(null);
  const [selected, setSelected] = useState<ErrorRow | null>(null);
  // Last-fetched timestamp for the "Refreshed Xs ago" label.
  const [lastFetch, setLastFetch] = useState<number>(0);

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (statusFamily) qs.set('statusFamily', statusFamily);
    qs.set('since', since);
    if (orgFilter)    qs.set('org', orgFilter);
    if (pathFilter)   qs.set('path', pathFilter);
    if (methodFilter) qs.set('method', methodFilter);
    qs.set('limit', '100');
    return qs.toString();
  }, [statusFamily, since, orgFilter, pathFilter, methodFilter]);

  // Debounce the path/org/method substring filters so each keystroke
  // doesn't issue a query. 350ms is the same beat as other search
  // boxes in the app.
  const debouncedQS = useDebounced(queryString, 350);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetch(`/api/admin/errors?${debouncedQS}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((json: ApiResp) => {
        if (cancelled) return;
        setData(json);
        setLastFetch(Date.now());
      })
      .catch(e => { if (!cancelled) setErr(e.message ?? 'fetch failed'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debouncedQS]);

  // Auto-refresh every 30s while the tab is foregrounded.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tick = () => {
      if (document.hidden) return;
      // Bypass debounce — just refetch with current params. We do this
      // by toggling a counter via a state-less ref bump on queryString
      // — but since queryString is already memoized, the simplest
      // approach is to refetch directly.
      void fetch(`/api/admin/errors?${queryString}`)
        .then(r => r.ok ? r.json() : null)
        .then((json: ApiResp | null) => {
          if (!json) return;
          setData(json);
          setLastFetch(Date.now());
        })
        .catch(() => {});
    };
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [queryString]);

  const rows = data?.rows ?? [];

  return (
    <AppShell title="API errors" icon={AlertOctagon}>
      <div className="flex-1 flex flex-col min-h-0 px-6 pt-5 pb-6 gap-4 overflow-y-auto">
        <Breadcrumbs trail={[
          { label: 'Admin', href: '/admin' },
          { label: 'API errors' },
        ]} />

        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div>
            <div className="text-[20px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              API errors
            </div>
            <div className="text-[12.5px]" style={{ color: 'var(--gc-text-3)' }}>
              Every 4xx / 5xx response captured by the API. Updates every 30s.
              {lastFetch > 0 && (
                <span style={{ color: 'var(--gc-text-3)' }}> · last refresh {fmtRelative(lastFetch)}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setLastFetch(0)} // trigger re-evaluation via effect chain on queryString isn't simplest; force by toggling state instead
            className="text-[12px] font-semibold inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg"
            style={{ background: 'var(--gc-bg)', color: 'var(--gc-text-2)', border: '1px solid var(--gc-border-light)' }}
          >
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>

        {/* Headline cards */}
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <HeadlineCard
            label="4xx (client) errors"
            sub={`Last ${since}`}
            value={data?.headline.count4xx ?? '—'}
            tone="amber"
          />
          <HeadlineCard
            label="5xx (server) errors"
            sub={`Last ${since}`}
            value={data?.headline.count5xx ?? '—'}
            tone="red"
          />
          <TopEndpointsCard endpoints={data?.headline.topEndpoints ?? []} />
        </div>

        {/* Filter strip */}
        <div className="flex flex-wrap gap-2 items-center text-[12px]">
          <FilterPills
            label="Status"
            options={[['', 'All'], ['4xx', '4xx only'], ['5xx', '5xx only']]}
            value={statusFamily}
            onChange={v => setStatusFamily(v as StatusFamily)}
          />
          <FilterPills
            label="Window"
            options={[['1h', '1h'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d']]}
            value={since}
            onChange={v => setSince(v as SinceKey)}
          />
          <SearchInput placeholder="org_id" value={orgFilter}    onChange={setOrgFilter} />
          <SearchInput placeholder="method" value={methodFilter} onChange={setMethodFilter} width={100} />
          <SearchInput placeholder="path substring (e.g. /v1/assets)" value={pathFilter} onChange={setPathFilter} width={260} />
        </div>

        {err && (
          <div className="rounded-lg px-3 py-2 text-[13px]"
            style={{ background: 'var(--gc-red-soft, #fee2e2)', color: 'var(--gc-red, #b91c1c)' }}>
            Failed to load: {err}
          </div>
        )}

        {/* Results table */}
        <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--gc-border-light)', background: 'var(--gc-surface)' }}>
          <div className="grid text-[11px] font-bold uppercase tracking-wider"
            style={{
              gridTemplateColumns: '170px 70px 1fr 70px 220px 1fr',
              gap: 8,
              padding: '10px 14px',
              borderBottom: '1px solid var(--gc-border-light)',
              background: 'var(--gc-bg)',
              color: 'var(--gc-text-3)',
            }}>
            <div>Time</div><div>Method</div><div>Path</div><div>Status</div><div>Org</div><div>Detail</div>
          </div>
          {loading && rows.length === 0 ? (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-center py-10 text-[13px]" style={{ color: 'var(--gc-text-3)' }}>
              No errors in the last {since} matching these filters. 🎉
            </div>
          ) : (
            rows.map(r => (
              <button
                key={r.id}
                type="button"
                onClick={() => setSelected(r)}
                className="grid w-full text-left transition-colors"
                style={{
                  gridTemplateColumns: '170px 70px 1fr 70px 220px 1fr',
                  gap: 8,
                  padding: '10px 14px',
                  borderBottom: '1px solid var(--gc-border-light)',
                  background: 'transparent',
                  fontSize: 12,
                  color: 'var(--gc-text-1)',
                }}
                onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
              >
                <div style={{ color: 'var(--gc-text-3)' }} className="font-mono">
                  {fmtAbsolute(r.occurred_at)}
                </div>
                <div className="font-mono font-bold" style={{ color: methodColor(r.method) }}>{r.method}</div>
                <div className="font-mono truncate" title={r.path}>{r.path}</div>
                <div>
                  <span className="font-mono font-bold px-1.5 py-0.5 rounded text-[11px]"
                    style={statusStyle(r.status)}>{r.status}</span>
                </div>
                <div className="font-mono text-[11px] truncate" style={{ color: 'var(--gc-text-3)' }} title={r.org_id ?? ''}>
                  {r.org_id ?? '—'}
                </div>
                <div className="truncate" title={r.detail ?? r.error_code ?? ''}>
                  {r.error_code && <span style={{ color: 'var(--gc-text-3)' }}>{r.error_code}{r.detail ? ' · ' : ''}</span>}
                  {r.detail ?? (r.error_code ? '' : '—')}
                </div>
              </button>
            ))
          )}
        </div>

        {data && data.totalMatching > rows.length && (
          <div className="text-[11px] text-center" style={{ color: 'var(--gc-text-3)' }}>
            Showing {rows.length} of {data.totalMatching.toLocaleString()} matching. Narrow filters or shorten the window to see more.
          </div>
        )}
      </div>

      {selected && <ErrorDrawer row={selected} onClose={() => setSelected(null)} />}
    </AppShell>
  );
}

/* ── Helpers ───────────────────────────────────────────────────── */

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  const handle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (handle.current) clearTimeout(handle.current);
    handle.current = setTimeout(() => setDebounced(value), ms);
    return () => { if (handle.current) clearTimeout(handle.current); };
  }, [value, ms]);
  return debounced;
}

function fmtAbsolute(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function fmtRelative(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function methodColor(m: string): string {
  if (m === 'GET')    return '#1a73e8';
  if (m === 'POST')   return '#188038';
  if (m === 'PATCH')  return '#b06000';
  if (m === 'DELETE') return '#d93025';
  return 'var(--gc-text-2)';
}

function statusStyle(s: number): React.CSSProperties {
  if (s >= 500) return { background: '#fdecec', color: '#b91c1c' };
  if (s >= 400) return { background: '#fef3c7', color: '#92400e' };
  return         { background: '#e8f0fe', color: '#1558d6' };
}

function FilterPills({ label, options, value, onChange }: {
  label:   string;
  options: ReadonlyArray<readonly [string, string]>;
  value:   string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      <span className="text-[11px] uppercase tracking-wider font-semibold" style={{ color: 'var(--gc-text-3)' }}>{label}</span>
      <div className="inline-flex rounded-lg overflow-hidden" style={{ border: '1px solid var(--gc-border-light)' }}>
        {options.map(([v, lbl]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className="px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
            style={{
              background: value === v ? 'var(--gc-blue-soft, #e8f0fe)' : 'var(--gc-surface)',
              color:      value === v ? 'var(--gc-blue)' : 'var(--gc-text-2)',
              borderRight: v === options[options.length - 1][0] ? 'none' : '1px solid var(--gc-border-light)',
            }}>
            {lbl}
          </button>
        ))}
      </div>
    </div>
  );
}

function SearchInput({ placeholder, value, onChange, width = 160 }: {
  placeholder: string;
  value:       string;
  onChange:    (v: string) => void;
  width?:      number;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className="px-2.5 py-1 text-[12px] rounded-lg font-mono"
      style={{
        width,
        background: 'var(--gc-surface)',
        border: '1px solid var(--gc-border-light)',
        color: 'var(--gc-text-1)',
        outline: 'none',
      }}
    />
  );
}

function HeadlineCard({ label, sub, value, tone }: {
  label: string;
  sub:   string;
  value: number | string;
  tone:  'amber' | 'red';
}) {
  const tones = {
    amber: { bg: '#fef3c7', text: '#92400e' },
    red:   { bg: '#fdecec', text: '#b91c1c' },
  } as const;
  const t = tones[tone];
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className="mt-1 inline-flex items-baseline gap-2">
        <span className="text-[28px] font-bold tabular-nums" style={{ color: t.text }}>{typeof value === 'number' ? value.toLocaleString() : value}</span>
        <span className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>{sub}</span>
      </div>
      <div className="mt-1 text-[10px] font-bold uppercase tracking-wider inline-block px-2 py-0.5 rounded"
        style={{ background: t.bg, color: t.text }}>
        {tone === 'red' ? 'server' : 'client'}
      </div>
    </div>
  );
}

function TopEndpointsCard({ endpoints }: { endpoints: Array<{ path: string; count: number }> }) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
      <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: 'var(--gc-text-3)' }}>Top error endpoints</div>
      {endpoints.length === 0 ? (
        <div className="text-[12px] mt-2" style={{ color: 'var(--gc-text-3)' }}>None in window.</div>
      ) : (
        <ul className="mt-2 space-y-1">
          {endpoints.map(e => (
            <li key={e.path} className="flex items-center justify-between text-[12px]">
              <span className="font-mono truncate" style={{ color: 'var(--gc-text-1)' }}>{e.path}</span>
              <span className="font-bold tabular-nums ml-2" style={{ color: 'var(--gc-text-2)' }}>{e.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ErrorDrawer({ row, onClose }: { row: ErrorRow; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[120] flex justify-end"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="h-full flex flex-col"
        style={{
          width: 560, maxWidth: '90vw',
          background: 'var(--gc-surface)',
          boxShadow: 'var(--shadow-3)',
          overflowY: 'auto',
        }}
      >
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <div>
            <div className="text-[15px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
              <span className="font-mono font-bold mr-2" style={{ color: methodColor(row.method) }}>{row.method}</span>
              <span className="font-mono">{row.path}</span>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
              {fmtAbsolute(row.occurred_at)} · {row.duration_ms ? `${row.duration_ms}ms` : '—'}
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full" style={{ color: 'var(--gc-text-2)' }}>
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 px-5 py-4 space-y-4">
          <FieldRow label="Status" mono>
            <span className="font-mono font-bold px-2 py-0.5 rounded" style={statusStyle(row.status)}>{row.status}</span>
          </FieldRow>
          {row.error_code && <FieldRow label="Error code" mono>{row.error_code}</FieldRow>}
          {row.detail && <FieldRow label="Detail">{row.detail}</FieldRow>}
          {row.org_id && (
            <FieldRow label="Org">
              <Link href={`/admin/orgs?org=${encodeURIComponent(row.org_id)}`}
                className="font-mono underline" style={{ color: 'var(--gc-blue)' }}>
                {row.org_id}
              </Link>
            </FieldRow>
          )}
          {row.user_id && <FieldRow label="User" mono>{row.user_id}</FieldRow>}
          {row.user_agent && <FieldRow label="User-agent" mono small>{row.user_agent}</FieldRow>}
          {row.body_snippet && (
            <FieldRow label="Request body (first 500)">
              <pre className="rounded-lg p-2 text-[11px] whitespace-pre-wrap font-mono overflow-x-auto"
                style={{ background: 'var(--gc-bg)', border: '1px solid var(--gc-border-light)', color: 'var(--gc-text-1)' }}>
                {prettyJSON(row.body_snippet)}
              </pre>
            </FieldRow>
          )}
        </div>
      </div>
    </div>
  );
}

function FieldRow({ label, children, mono, small }: { label: string; children: React.ReactNode; mono?: boolean; small?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold mb-1" style={{ color: 'var(--gc-text-3)' }}>{label}</div>
      <div className={`${small ? 'text-[11px]' : 'text-[13px]'} ${mono ? 'font-mono' : ''}`} style={{ color: 'var(--gc-text-1)', wordBreak: 'break-word' }}>
        {children}
      </div>
    </div>
  );
}

function prettyJSON(s: string): string {
  try { return JSON.stringify(JSON.parse(s), null, 2); }
  catch { return s; }
}
