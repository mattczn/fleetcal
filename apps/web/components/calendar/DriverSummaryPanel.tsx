'use client';

/**
 * DriverSummaryPanel — right-side preview pane in the load modal that
 * formats the load into a copy-pasteable summary for driver group chats.
 *
 * Why it exists: dispatchers usually re-type the same load info into a
 * Slack/text/WhatsApp thread when they hand a load to a driver.
 * Title + window, asset + load #, refs, trailer type, and every stop
 * with a Google Maps link, appointment window, and instructions. One
 * button copies the whole thing as plain text.
 */

import { useMemo, useState } from 'react';
import { Copy, X } from 'lucide-react';
import type { CalendarEvent, Stop, RefNum, Asset, Trailer } from '@/lib/types';

interface Props {
  event: Partial<CalendarEvent> & { stops?: Stop[]; refNums?: RefNum[]; trailerType?: string };
  asset?: Asset;
  trailer?: Trailer;
  driverName?: string;
  onClose: () => void;
}

// ── Formatters ──────────────────────────────────────────────────────

function fmtDateTime(iso?: string): string {
  if (!iso) return '';
  const [d, t] = iso.split('T');
  if (!d) return '';
  const [yyyy, mm, dd] = d.split('-');
  const date = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  const wd = date.toLocaleDateString('en-US', { weekday: 'short' });
  const md = `${Number(mm)}/${Number(dd)}`;
  return t ? `${wd} ${md} ${t.slice(0, 5)}` : `${wd} ${md}`;
}

function fmtAppointment(s: Stop): string {
  const start = s.apptStart;
  const end   = s.apptEnd;
  const kind  = s.scheduleType;
  if (!start && !end) return '';
  // FCFS — open-window same-day appointments. Treat both endpoints as times.
  if (kind === 'fcfs') {
    const a = start ? fmtDateTime(start) : '';
    const b = end ? (end.split('T')[1] ?? '').slice(0, 5) : '';
    return b ? `FCFS ${a}–${b}` : `FCFS ${a}`;
  }
  // Window with both endpoints — show full range, suppress repeated date.
  if (kind === 'window' && start && end) {
    const sd = start.split('T')[0];
    const ed = end.split('T')[0];
    const a = fmtDateTime(start);
    const bTime = (end.split('T')[1] ?? '').slice(0, 5);
    const b = sd === ed ? bTime : fmtDateTime(end);
    return `Window ${a}–${b}`;
  }
  if (start) {
    return `Appt ${fmtDateTime(start)}`;
  }
  return '';
}

function stopLabel(t: Stop['type']): string {
  switch (t) {
    case 'pickup':    return 'PICKUP';
    case 'delivery':  return 'DELIVERY';
    case 'drop':      return 'DROP';
    case 'drop_hook': return 'DROP & HOOK';
    case 'relay':     return 'RELAY HANDOFF';
    default:          return 'STOP';
  }
}

function fullAddress(s: Stop): string {
  const parts = [s.address, s.city, s.state].filter(Boolean);
  return parts.join(', ');
}

function googleMapsUrl(s: Stop): string {
  const q = fullAddress(s) || s.facilityName || '';
  if (!q) return '';
  // Short ?q= form — universally redirects to the Maps app on mobile
  // and the Maps web app on desktop. ~30 chars shorter per stop than
  // the verbose /maps/search/?api=1&query= variant.
  return `https://maps.google.com/?q=${encodeURIComponent(q)}`;
}

// ── Plain-text summary builder ──────────────────────────────────────
// Plain text only (no markdown) so it lands cleanly in iMessage / SMS /
// Slack / WhatsApp without weird escaping.

function buildPlainText(args: {
  title: string;
  start?: string;
  end?: string;
  assetName?: string;
  driverName?: string;
  loadNum?: string;
  refNums?: RefNum[];
  trailerType?: string;
  trailerName?: string;
  stops: Stop[];
  loadNotes?: string;
}): string {
  const lines: string[] = [];

  const headerTime = [fmtDateTime(args.start), fmtDateTime(args.end)].filter(Boolean).join(' → ');
  lines.push(`LOAD: ${args.title}`);
  if (headerTime) lines.push(headerTime);
  lines.push('');

  const meta: string[] = [];
  if (args.assetName)    meta.push(`Asset: ${args.assetName}`);
  if (args.driverName)   meta.push(`Driver: ${args.driverName}`);
  if (args.loadNum)      meta.push(`Load #: ${args.loadNum}`);
  if (args.trailerType)  meta.push(`Trailer: ${args.trailerType}${args.trailerName ? ` (${args.trailerName})` : ''}`);
  else if (args.trailerName) meta.push(`Trailer: ${args.trailerName}`);
  for (const m of meta) lines.push(m);

  if (args.refNums && args.refNums.length > 0) {
    const refs = args.refNums
      .filter(r => r.value?.trim())
      .map(r => `${r.label || 'Ref'}: ${r.value}`);
    if (refs.length) lines.push(`Refs — ${refs.join(' · ')}`);
  }

  if (args.stops.length > 0) {
    lines.push('');
    lines.push('STOPS');
    args.stops.forEach((s, idx) => {
      const head = `${idx + 1}. ${stopLabel(s.type)}${s.facilityName ? ` — ${s.facilityName}` : ''}`;
      lines.push(head);
      const addr = fullAddress(s);
      if (addr) {
        const url = googleMapsUrl(s);
        // Single line: "address — maps.google.com/?q=…". Keeps the
        // copy compact in chats; the URL is still tappable.
        lines.push(url ? `   ${addr} — ${url}` : `   ${addr}`);
      }
      const appt = fmtAppointment(s);
      if (appt) lines.push(`   ${appt}`);
      if (s.instructions?.trim()) lines.push(`   Notes: ${s.instructions.trim()}`);
    });
  }

  if (args.loadNotes?.trim()) {
    lines.push('');
    lines.push(`Special instructions: ${args.loadNotes.trim()}`);
  }

  return lines.join('\n');
}

// ── Component ───────────────────────────────────────────────────────

export default function DriverSummaryPanel({ event, asset, trailer, driverName, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const plain = useMemo(() => buildPlainText({
    title:        event.title ?? '',
    start:        event.start,
    end:          event.end,
    assetName:    asset?.name,
    driverName,
    loadNum:      event.loadNum,
    refNums:      event.refNums,
    trailerType:  event.trailerType,
    trailerName:  trailer?.name,
    stops:        event.stops ?? [],
    loadNotes:    event.notes ?? event.specialInstructions ?? undefined,
  }), [event, asset, trailer, driverName]);

  const onCopy = () => {
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(plain).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  const stops = event.stops ?? [];

  return (
    <div className="flex flex-col shrink-0"
      style={{ width: 380, borderLeft: '1px solid var(--gc-border)', background: 'var(--gc-bg)' }}>
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid var(--gc-border)', background: 'var(--gc-surface)' }}>
        <div className="text-[13px] font-extrabold" style={{ color: 'var(--gc-text-1)' }}>
          Driver summary
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onCopy}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-bold transition-colors"
            style={copied
              ? { background: '#dcfce7', color: '#15803d', border: '1px solid #86efac' }
              : { background: 'var(--gc-blue)', color: '#fff', border: '1px solid var(--gc-blue)' }}>
            <Copy size={12} />
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button type="button" onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: 'var(--gc-text-3)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Body — visual preview, scrollable */}
      <div className="flex-1 overflow-auto p-4 space-y-3" style={{ fontSize: 13, color: 'var(--gc-text-1)' }}>
        {/* Title block */}
        <div>
          <div className="text-[15px] font-extrabold leading-tight">
            {event.title || <span style={{ color: 'var(--gc-text-3)' }}>(no title)</span>}
          </div>
          {(event.start || event.end) && (
            <div className="text-xs mt-0.5" style={{ color: 'var(--gc-text-2)', fontVariantNumeric: 'tabular-nums' }}>
              {fmtDateTime(event.start)}{event.end ? ` → ${fmtDateTime(event.end)}` : ''}
            </div>
          )}
        </div>

        {/* Meta block */}
        <div className="rounded-lg p-3 space-y-1 text-[12px]"
          style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
          {asset?.name && (
            <div><span style={{ color: 'var(--gc-text-3)' }}>Asset:</span> <span style={{ fontWeight: 600 }}>{asset.name}</span></div>
          )}
          {driverName && (
            <div><span style={{ color: 'var(--gc-text-3)' }}>Driver:</span> <span style={{ fontWeight: 600 }}>{driverName}</span></div>
          )}
          {event.loadNum && (
            <div><span style={{ color: 'var(--gc-text-3)' }}>Load #:</span> <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{event.loadNum}</span></div>
          )}
          {(event.trailerType || trailer?.name) && (
            <div>
              <span style={{ color: 'var(--gc-text-3)' }}>Trailer:</span>{' '}
              <span style={{ fontWeight: 600 }}>
                {event.trailerType || ''}
                {event.trailerType && trailer?.name ? ' · ' : ''}
                {trailer?.name || ''}
              </span>
            </div>
          )}
          {event.refNums && event.refNums.filter(r => r.value?.trim()).length > 0 && (
            <div>
              <span style={{ color: 'var(--gc-text-3)' }}>Refs:</span>{' '}
              <span style={{ fontWeight: 600 }}>
                {event.refNums.filter(r => r.value?.trim()).map(r => `${r.label || 'Ref'} ${r.value}`).join(' · ')}
              </span>
            </div>
          )}
        </div>

        {/* Stops list */}
        {stops.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--gc-text-3)' }}>
              Stops
            </div>
            {stops.map((s, idx) => {
              const appt = fmtAppointment(s);
              const url = googleMapsUrl(s);
              const addr = fullAddress(s);
              return (
                <div key={s.id ?? idx} className="rounded-lg p-3 space-y-1.5 text-[12px]"
                  style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border-light)' }}>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-extrabold px-1.5 py-0.5 rounded"
                      style={{
                        background: s.type === 'pickup' ? '#dbeafe' : s.type === 'delivery' ? '#dcfce7' : 'var(--gc-border-light)',
                        color: s.type === 'pickup' ? '#1e40af' : s.type === 'delivery' ? '#15803d' : 'var(--gc-text-2)',
                      }}>
                      {idx + 1}. {stopLabel(s.type)}
                    </span>
                    {s.facilityName && <span style={{ fontWeight: 700 }}>{s.facilityName}</span>}
                  </div>
                  {addr && (
                    url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        title="Open in Google Maps"
                        className="block transition-colors"
                        style={{ color: 'var(--gc-blue)', textDecoration: 'underline', textDecorationColor: 'var(--gc-border)' }}
                        onMouseEnter={e => (e.currentTarget.style.textDecorationColor = 'var(--gc-blue)')}
                        onMouseLeave={e => (e.currentTarget.style.textDecorationColor = 'var(--gc-border)')}>
                        {addr}
                      </a>
                    ) : (
                      <div style={{ color: 'var(--gc-text-2)' }}>{addr}</div>
                    )
                  )}
                  {appt && (
                    <div style={{ color: 'var(--gc-text-2)', fontVariantNumeric: 'tabular-nums' }}>
                      {appt}
                    </div>
                  )}
                  {s.instructions?.trim() && (
                    <div style={{ color: 'var(--gc-text-2)', whiteSpace: 'pre-wrap' }}>
                      Notes: {s.instructions.trim()}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Load-level special instructions */}
        {(event.notes ?? event.specialInstructions ?? '').trim() && (
          <div className="rounded-lg p-3 text-[12px]"
            style={{ background: '#fef9c3', border: '1px solid #fde68a' }}>
            <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: '#854d0e' }}>
              Special Instructions
            </div>
            <div style={{ color: '#713f12', whiteSpace: 'pre-wrap' }}>
              {(event.notes ?? event.specialInstructions ?? '').trim()}
            </div>
          </div>
        )}

        {/* Plain-text view at the bottom — what actually gets copied. */}
        <details className="text-[11px]">
          <summary className="cursor-pointer font-bold" style={{ color: 'var(--gc-text-3)' }}>
            Plain-text preview
          </summary>
          <pre className="mt-2 p-2 rounded text-[11px] whitespace-pre-wrap"
            style={{ background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)' }}>
{plain}
          </pre>
        </details>
      </div>
    </div>
  );
}
