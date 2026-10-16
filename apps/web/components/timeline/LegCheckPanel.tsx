'use client';

/**
 * GPS check for one calendar leg, shown in the timeline's detail column:
 * what the truck's GPS shows at each stop versus the calendar, the miles
 * the linker charged to the leg, and a place to mark it right or wrong
 * (saved as training data) or ask the AI what happened.
 *
 * Fixing an individual link still happens on the timeline itself — click
 * the trip and change it; manual links are never overwritten by the
 * linker. See docs/movement-linking.md.
 */

import { useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import type { LinkReviewEntry, LinkReviewItem, LinkReviewReason } from '@fleetcal/types';
import { railway } from '@/lib/railway';

export const CONFIDENCE_STYLE: Record<'high' | 'medium' | 'low', { bg: string; fg: string; label: string }> = {
  high:   { bg: '#e6f4ea', fg: '#1e8e3e', label: 'GPS matches' },
  medium: { bg: '#fef7e0', fg: '#b06000', label: 'Check' },
  low:    { bg: '#fce8e6', fg: '#c5221f', label: 'Needs review' },
};

export const ISSUE_LABEL: Record<string, string> = {
  stop_not_found:    'Stop not found on GPS',
  stop_out_of_order: 'Stop visited out of order',
  gps_gap:           'ELD was off',
  no_stops:          'Load has no stops',
  miles_mismatch:    'GPS miles ≠ route miles',
  detour:            'Detour on empty miles',
  stop_no_coords:    'Stop has no map pin',
  no_gps:            'Truck has no GPS',
};

const REASON_LABEL: Record<LinkReviewReason, string> = {
  wrong_truck:         'Wrong truck (load changed trucks)',
  stop_pin_wrong:      'Stop pin is in the wrong place',
  wrong_stop_matched:  'Matched the wrong GPS stop',
  calendar_time_wrong: 'Calendar times are off',
  missing_stops:       'Calendar is missing stops',
  miles_wrong:         'Miles charged are wrong',
  other:               'Something else',
};

const CAUSE_LABEL: Record<string, string> = {
  truck_swap:         'Truck swap',
  stop_pin_wrong:     'Stop pin off',
  calendar_time_off:  'Calendar times off',
  missing_stops:      'Missing stops',
  consolidated_loads: 'Carried with another load',
  gps_off:            'ELD off',
  detour_or_errand:   'Detour / errand',
  linking_error:      'Matched the wrong visit',
  looks_correct:      'Looks correct',
  unclear:            'Unclear',
};

function fmt(iso: string | null | undefined, tz: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
const mi = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)} mi`);
const hrs = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)} h`);

export default function LegCheckPanel({
  item, reviewsAvailable, tz, fs, onChanged,
}: {
  /** undefined = the linker hasn't checked this leg yet. */
  item: LinkReviewItem | undefined;
  reviewsAvailable: boolean;
  tz: string;
  fs: (px: number) => number;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<'idle' | 'wrong'>('idle');
  const [reason, setReason] = useState<LinkReviewReason>('wrong_truck');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [asking, setAsking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [aiLocal, setAiLocal] = useState<LinkReviewEntry | null>(null);
  const [reviewLocal, setReviewLocal] = useState<LinkReviewEntry | null>(null);

  const label = { color: 'var(--gc-text-3)', fontSize: fs(11) } as const;

  if (!item) {
    return (
      <div className="pt-3" style={{ borderTop: '1px solid var(--gc-border)' }}>
        <div className="font-semibold uppercase tracking-wider mb-1" style={label}>GPS check</div>
        <div style={{ color: 'var(--gc-text-3)', fontSize: fs(12) }}>
          Not checked yet — the linker runs every 6 hours and skips the last few hours of driving.
        </div>
      </div>
    );
  }

  const conf = CONFIDENCE_STYLE[item.confidence];
  const review = reviewLocal ?? item.review;
  const ai = aiLocal ?? item.ai;

  async function save(verdict: 'correct' | 'wrong') {
    if (!item) return;
    setSaving(true); setErr(null);
    try {
      const r = await railway.reviewLink(item.eventId, verdict === 'wrong' ? { verdict, reason, note: note.trim() || undefined } : { verdict });
      setReviewLocal(r.review);
      setMode('idle'); setNote('');
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function askAi() {
    if (!item) return;
    setAsking(true); setErr(null);
    try {
      const r = await railway.explainLink(item.eventId);
      setAiLocal(r.ai);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The AI could not explain this leg');
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="pt-3 space-y-3" style={{ borderTop: '1px solid var(--gc-border)' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold uppercase tracking-wider" style={label}>GPS check</span>
        <span className="px-1.5 py-0.5 rounded font-semibold" style={{ background: conf.bg, color: conf.fg, fontSize: fs(10) }}>
          {conf.label}
        </span>
        {item.issues.map((i) => (
          <span key={i} className="px-1.5 py-0.5 rounded" style={{ background: 'var(--gc-surface-2)', color: 'var(--gc-text-2)', fontSize: fs(10) }}>
            {ISSUE_LABEL[i] ?? i}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums" style={{ fontSize: fs(12), color: 'var(--gc-text-2)' }}>
        <span>GPS loaded</span><span style={{ color: 'var(--gc-text-1)' }}>{mi(item.loadedMiles)}{item.routeMiles != null ? ` (route ${mi(item.routeMiles)})` : ''}</span>
        <span>Deadhead in</span><span style={{ color: 'var(--gc-text-1)' }}>{mi(item.deadheadMiles)}</span>
        <span>Return after</span><span style={{ color: 'var(--gc-text-1)' }}>{mi(item.returnMiles)}</span>
        <span>At the docks</span><span style={{ color: 'var(--gc-text-1)' }}>{hrs(item.dwellHours)}</span>
        {item.restHours ? <><span>Rest on the road</span><span style={{ color: 'var(--gc-text-1)' }}>{hrs(item.restHours)}</span></> : null}
        <span>Truck on this leg</span><span style={{ color: 'var(--gc-text-1)' }}>{fmt(item.truckStart, tz)} → {fmt(item.truckEnd, tz)}</span>
      </div>

      {item.stops.length > 0 ? (
        <div className="space-y-1.5">
          {item.stops.map((s) => (
            <div key={s.stopId} style={{ fontSize: fs(12) }}>
              <div className="font-semibold" style={{ color: 'var(--gc-text-1)' }}>{s.label}</div>
              {s.arrive || s.depart ? (
                <div style={{ color: 'var(--gc-text-2)' }}>
                  GPS: arrived {fmt(s.arrive, tz)} · left {fmt(s.depart, tz)}
                  {s.distMi != null ? ` · ${s.distMi.toFixed(2)} mi from pin` : ''}
                  {s.offH != null && s.offH > 0 ? ` · ${s.offH.toFixed(1)} h off the calendar` : ''}
                </div>
              ) : (
                <div style={{ color: '#c5221f' }}>
                  {ISSUE_LABEL[s.issue ?? ''] ?? 'Not found on GPS'}
                  {s.nearest ? ` — truck got within ${s.nearest.distMi.toFixed(1)} mi (${s.nearest.offH.toFixed(1)} h off)` : ''}
                </div>
              )}
              {s.otherTrucks.length > 0 ? (
                <div style={{ color: '#b06000' }}>
                  Also there: {s.otherTrucks.map((o) => `${o.name} at ${fmt(o.arrive, tz)}`).join(', ')}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {ai?.suggestion ? (
        <div className="rounded p-2 space-y-1" style={{ background: 'var(--gc-surface-2)', fontSize: fs(12) }}>
          <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--gc-text-1)' }}>
            <Sparkles size={13} /> {CAUSE_LABEL[ai.suggestion.cause] ?? ai.suggestion.cause}
            <span className="font-normal" style={{ color: 'var(--gc-text-3)' }}>· {ai.suggestion.confidence} confidence</span>
          </div>
          <div style={{ color: 'var(--gc-text-2)' }}>{ai.suggestion.summary}</div>
          <div style={{ color: 'var(--gc-text-1)' }}><span className="font-semibold">Fix:</span> {ai.suggestion.fix}</div>
        </div>
      ) : null}

      {review ? (
        <div style={{ fontSize: fs(12), color: review.verdict === 'correct' ? '#1e8e3e' : '#c5221f' }}>
          {review.verdict === 'correct' ? 'Marked right' : `Marked wrong — ${REASON_LABEL[review.reason as LinkReviewReason] ?? review.reason ?? ''}`}
          {review.createdByName ? ` by ${review.createdByName}` : ''} · {fmt(review.createdAt, tz)}
          {review.note ? <div style={{ color: 'var(--gc-text-2)' }}>“{review.note}”</div> : null}
        </div>
      ) : null}

      {mode === 'wrong' ? (
        <div className="space-y-2">
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value as LinkReviewReason)}
            className="w-full rounded px-2 py-1"
            style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', fontSize: fs(12) }}
          >
            {(Object.keys(REASON_LABEL) as LinkReviewReason[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What actually happened? (e.g. CT-2028 picked it up at Niagara, swapped at the yard)"
            className="w-full rounded px-2 py-1"
            style={{ border: '1px solid var(--gc-border)', background: 'var(--gc-surface)', color: 'var(--gc-text-1)', fontSize: fs(12) }}
          />
          <div className="flex gap-2">
            <button type="button" disabled={saving} onClick={() => void save('wrong')}
              className="px-2.5 py-1 rounded font-semibold" style={{ background: '#c5221f', color: '#fff', fontSize: fs(12) }}>
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button type="button" onClick={() => setMode('idle')}
              className="px-2.5 py-1 rounded" style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', fontSize: fs(12) }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2 flex-wrap">
          <button type="button" disabled={saving || !reviewsAvailable} onClick={() => void save('correct')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-semibold"
            style={{ border: '1px solid #1e8e3e', color: '#1e8e3e', fontSize: fs(12), opacity: reviewsAvailable ? 1 : 0.5 }}>
            <Check size={13} /> Looks right
          </button>
          <button type="button" disabled={!reviewsAvailable} onClick={() => setMode('wrong')}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-semibold"
            style={{ border: '1px solid #c5221f', color: '#c5221f', fontSize: fs(12), opacity: reviewsAvailable ? 1 : 0.5 }}>
            <X size={13} /> Something&apos;s wrong
          </button>
          <button type="button" disabled={asking} onClick={() => void askAi()}
            className="flex items-center gap-1 px-2.5 py-1 rounded font-semibold"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', fontSize: fs(12) }}>
            {asking ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
            {asking ? 'Asking… (~20 s)' : ai ? 'Ask AI again' : 'Ask AI'}
          </button>
        </div>
      )}
      {!reviewsAvailable ? (
        <div style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>Verdicts can be saved once the link_reviews migration has been run.</div>
      ) : null}
      <div style={{ color: 'var(--gc-text-3)', fontSize: fs(11) }}>
        To fix a single link, click that trip on the timeline and change it — the linker never overwrites a link you set.
      </div>
      {err ? <div style={{ color: '#c5221f', fontSize: fs(12) }}>{err}</div> : null}
    </div>
  );
}
