'use client';

/**
 * Suggested driver pay for a leg, from what settled payroll paid on the
 * same route (apps/api/src/lib/routePay.ts). A chip next to the pay field;
 * hovering shows where the number came from and the recent paid legs
 * behind it. It never changes pay by itself — "Use" does, when offered.
 */

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PaySuggestion, PaySuggestRequest, PaySuggestStop, RouteLegKind, Stop } from '@fleetcal/types';
import { railway } from '@/lib/railway';

export const KIND_LABEL: Record<RouteLegKind, string> = {
  pickup: 'Pickup',
  delivery: 'Delivery',
  pickup_linehaul: 'Pickup + line haul',
  linehaul_delivery: 'Line haul + delivery',
  transfer: 'Transfer (yard to yard)',
  whole_local: 'Whole load (local)',
  whole_long: 'Whole load (long)',
};

const money = (n: number) => `$${Math.round(n).toLocaleString()}`;

/** A form stop as the suggest endpoint takes it. */
export const toSuggestStop = (s: Pick<Stop, 'lat' | 'lng' | 'type' | 'isHandoff' | 'city' | 'state' | 'facilityName'>): PaySuggestStop => ({
  lat: s.lat, lng: s.lng, type: s.type, isHandoff: s.isHandoff, city: s.city, state: s.state, facilityName: s.facilityName,
});

/** Suggestions by event id, for lists (the payroll page). */
export const PaySuggestionsContext = createContext<Map<string, PaySuggestion | null>>(new Map());
export const usePaySuggestionFor = (eventId: string) => useContext(PaySuggestionsContext).get(eventId);

/** Fetch suggestions for a set of legs. Re-fetches when the legs change. */
export function usePaySuggestions(legs: PaySuggestRequest['legs'], enabled = true): Map<string, PaySuggestion | null> {
  const reqKey = enabled && legs.length ? JSON.stringify(legs) : '';
  const [result, setResult] = useState<{ key: string; map: Map<string, PaySuggestion | null> } | null>(null);
  useEffect(() => {
    if (!reqKey) return;
    let cancelled = false;
    railway.suggestPay({ legs: JSON.parse(reqKey) as PaySuggestRequest['legs'] })
      .then((res) => { if (!cancelled) setResult({ key: reqKey, map: new Map(Object.entries(res.suggestions)) }); })
      .catch(() => { if (!cancelled) setResult({ key: reqKey, map: new Map() }); });
    return () => { cancelled = true; };
  }, [reqKey]);
  return result?.key === reqKey ? result.map : EMPTY;
}
const EMPTY = new Map<string, PaySuggestion | null>();

function sourceLine(s: PaySuggestion): string {
  switch (s.source) {
    case 'standard':
      return `Standard pay for this route${s.note ? ` — ${s.note}` : ''}.`;
    case 'route': {
      const window = Math.min(s.legs, 20);
      const exact = s.usualShare != null ? Math.round(s.usualShare * window) : null;
      return `Usual pay on this route: ${money(s.amount)}${exact != null ? ` on ${exact} of the last ${window} paid legs` : ''} (${s.legs} paid in all).`;
    }
    case 'area':
      return `No settled pay on this exact route yet — usual between the same areas, from ${s.legs} paid legs.`;
    case 'kind':
      return `No settled pay on this route yet — estimated from ${s.legs} paid ${KIND_LABEL[s.kind].toLowerCase()} legs (${s.miles} mi).`;
  }
}

export function SuggestedPayChip({ suggestion, current, onUse, disabled }: {
  suggestion: PaySuggestion | null | undefined;
  current: number | null;
  /** Offer a "Use" button that sets pay to the suggestion. */
  onUse?: (amount: number) => void;
  disabled?: boolean;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!suggestion) return null;
  const matches = current != null && Math.abs(current - suggestion.amount) < 0.5;
  const tone = matches
    ? { bg: '#e6f4ea', fg: '#1e8e3e', border: '#ceead6' }
    : current == null
      ? { bg: '#e8f0fe', fg: '#1a73e8', border: '#d2e3fc' }
      : { bg: '#fef7e0', fg: '#b06000', border: '#feefc3' };
  const show = () => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true); };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 150); };
  return (
    <span ref={chipRef} onMouseEnter={show} onMouseLeave={hide} className="inline-flex">
      <span className="px-1.5 py-0.5 rounded-lg font-semibold whitespace-nowrap cursor-default"
        style={{ fontSize: 10, background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
        {matches ? `✓ ${suggestion.source === 'standard' ? 'standard' : 'usual'}` : `Suggested ${money(suggestion.amount)}`}
      </span>
      {open ? (
        <SuggestionPopover anchor={chipRef} suggestion={suggestion} current={current} onEnter={show} onLeave={hide}
          onUse={onUse && !disabled && !matches ? () => { onUse(suggestion.amount); setOpen(false); } : undefined} />
      ) : null}
    </span>
  );
}

function SuggestionPopover({ anchor, suggestion: s, current, onUse, onEnter, onLeave }: {
  anchor: React.RefObject<HTMLSpanElement | null>;
  suggestion: PaySuggestion;
  current: number | null;
  onUse?: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current?.getBoundingClientRect();
    const b = bubbleRef.current;
    if (!a || !b) return;
    let top = a.bottom + 4;
    if (top + b.offsetHeight > window.innerHeight - 8) top = a.top - b.offsetHeight - 4;
    let left = a.left;
    if (left + b.offsetWidth > window.innerWidth - 8) left = window.innerWidth - b.offsetWidth - 8;
    setPos({ top, left: Math.max(8, left) });
  }, [anchor]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={bubbleRef} onMouseEnter={onEnter} onMouseLeave={onLeave}
      style={{
        position: 'fixed', top: pos?.top ?? -9999, left: pos?.left ?? -9999, zIndex: 10000, width: 340,
        background: 'var(--gc-surface)', border: '1px solid var(--gc-border)', borderRadius: 10,
        boxShadow: '0 8px 24px rgba(0,0,0,0.16)', padding: 12, fontSize: 12, color: 'var(--gc-text-2)',
      }}>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="font-semibold" style={{ color: 'var(--gc-text-1)', fontSize: 15 }}>{money(s.amount)}</span>
        <span style={{ color: 'var(--gc-text-3)', fontSize: 11 }}>{KIND_LABEL[s.kind]} · {s.miles} mi</span>
      </div>
      <div className="mb-1" style={{ color: 'var(--gc-text-1)' }}>{s.routeLabel}</div>
      <div className="mb-2">{sourceLine(s)}</div>
      {s.examples.length ? (
        <>
          <div className="font-semibold uppercase tracking-wider mb-1" style={{ fontSize: 10, color: 'var(--gc-text-3)' }}>
            Recent paid legs
          </div>
          <table className="w-full tabular-nums" style={{ fontSize: 11 }}>
            <tbody>
              {s.examples.slice(0, 8).map((e) => (
                <tr key={e.eventId}>
                  <td className="pr-2 whitespace-nowrap" style={{ color: 'var(--gc-text-3)' }}>
                    {new Date(`${e.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}
                  </td>
                  <td className="pr-2 whitespace-nowrap">#{e.loadNum ?? '—'}</td>
                  <td className="pr-2 truncate" style={{ maxWidth: 120 }}>{e.driver}</td>
                  <td className="text-right font-semibold" style={{ color: 'var(--gc-text-1)' }}>{money(e.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2" style={{ fontSize: 10, color: 'var(--gc-text-3)' }}>
        <span>Settled payroll only (weeks finalized a week or more ago).</span>
        {onUse ? (
          <button type="button" onClick={onUse} className="px-2 py-1 rounded font-semibold whitespace-nowrap"
            style={{ background: 'var(--gc-blue)', color: '#fff', fontSize: 11 }}>
            Use {money(s.amount)}{current != null ? ` (was ${money(current)})` : ''}
          </button>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
