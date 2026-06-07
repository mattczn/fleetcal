'use client';

/**
 * Customer combobox — search-as-you-type input with a dark dropdown of
 * matching customers and a "Create new" hook for unknown names.
 *
 * Lifted out of EventModal so the load detail page can render the same
 * widget. Any visual / behavioral change here lands in both surfaces.
 *
 * onPick is the canonical "user chose a real customer" callback — it
 * carries the WHOLE Customer record so the parent can bind broker text
 * AND customerId (FK) atomically. Without that pair the FK silently
 * drifts when a re-pick from "Customer A" to "Customer B" only updates
 * the broker text. onCreateNew fires when the typed name doesn't match
 * any customer — typically the parent opens NewBrokerReviewModal.
 */

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, AlertCircle, Plus } from 'lucide-react';
import { inputStyle, blurColor } from './EventModalForm';
import type { Customer } from '@fleetcal/types';

export interface CustomerComboboxProps {
  value: string;
  /** Fires on every keystroke when the user is free-typing. Parent
   *  mirrors the text into the broker field; the customer-match effect
   *  decides whether to also bind customerId. */
  onChange: (val: string) => void;
  /** Fires when the user clicks a customer in the dropdown. Carries
   *  the full Customer record so the parent can update broker text
   *  AND customerId together. */
  onPick?: (customer: Customer) => void;
  customers: Customer[];
  inputRef?: React.RefObject<HTMLInputElement | null>;
  accentColor?: string;
  /** Fires when the user clicks "Add &lt;query&gt;" at the bottom of
   *  the dropdown — invoked only when query is non-empty AND doesn't
   *  match any existing customer by name. */
  onCreateNew?: (name: string) => Promise<void> | void;
}

export function CustomerCombobox({
  value, onChange, onPick, customers, inputRef, accentColor, onCreateNew,
}: CustomerComboboxProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const style = inputStyle();

  // Sync external value changes (e.g. from rate con parse / undo).
  useEffect(() => { setQuery(value); }, [value]);

  // Close on outside click — covered with mousedown so the input's
  // blur doesn't fire first and skip the row click on the dropdown.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = query.trim()
    ? customers.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        c.aliases.some(a => a.toLowerCase().includes(query.toLowerCase()))
      )
    : customers;

  const isLinked = customers.some(c => c.name === value);

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <div style={{ position: 'relative' }}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="text"
          value={query}
          placeholder="Search customers…"
          style={{ ...style, paddingRight: 28 }}
          onFocus={e => { setOpen(true); if (accentColor) e.currentTarget.style.borderColor = accentColor; }}
          onChange={e => {
            setQuery(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onBlur={blurColor}
        />
        {isLinked ? (
          <CheckCircle2 size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: '#16a34a', pointerEvents: 'none' }} />
        ) : value.trim() ? (
          <AlertCircle size={13} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: '#f59e0b', pointerEvents: 'none' }} />
        ) : null}
      </div>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
          background: '#1e2433', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 10, marginTop: 4, maxHeight: 200, overflowY: 'auto',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
        }}>
          {filtered.map(c => (
            <button
              key={c.id}
              type="button"
              onMouseDown={e => {
                e.preventDefault();
                setQuery(c.name);
                if (onPick) onPick(c);
                else        onChange(c.name);
                setOpen(false);
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '9px 12px', background: 'none', border: 'none',
                cursor: 'pointer', color: 'rgba(255,255,255,0.85)', fontSize: 13,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              {c.name}
              {c.aliases.length > 0 && (
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginLeft: 6 }}>
                  aka {c.aliases.slice(0, 2).join(', ')}
                </span>
              )}
            </button>
          ))}
          {onCreateNew && query.trim() && !customers.some(c => c.name.toLowerCase() === query.trim().toLowerCase()) && (
            <button
              type="button"
              onMouseDown={async e => {
                e.preventDefault();
                setOpen(false);
                await onCreateNew(query.trim());
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                padding: '9px 12px', background: 'none', border: 'none',
                borderTop: filtered.length > 0 ? '1px solid rgba(255,255,255,0.08)' : 'none',
                cursor: 'pointer', color: '#60a5fa', fontSize: 13, fontWeight: 700,
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            >
              <Plus size={13} /> Add &ldquo;{query.trim()}&rdquo;
            </button>
          )}
        </div>
      )}
    </div>
  );
}
