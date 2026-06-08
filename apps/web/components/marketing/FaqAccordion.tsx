'use client';

/**
 * FaqAccordion — single-open FAQ list.
 *
 * First item opens by default (per handoff spec). Tapping an
 * already-open item closes it (toggle). The `+` icon rotates
 * 45° to become `×` when its item is open.
 *
 * Heights animate via CSS max-height — we cap at 320px which
 * comfortably fits every answer in the handoff copy (longest
 * is ~140 chars). If copy grows past that later, swap to a
 * measure-then-animate pattern instead of bumping the cap.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';

export interface FaqItem { q: string; a: string }

export default function FaqAccordion({ items }: { items: readonly FaqItem[] }) {
  const [open, setOpen] = useState(0);

  return (
    <div>
      {items.map((item, i) => {
        const isOpen = open === i;
        return (
          <div
            key={item.q}
            style={{ borderBottom: '1px solid #e8eaed' }}
          >
            <button
              type="button"
              onClick={() => setOpen(isOpen ? -1 : i)}
              aria-expanded={isOpen}
              className="w-full flex items-center justify-between gap-6 font-display text-left"
              style={{
                background: 'transparent',
                border:     'none',
                cursor:     'pointer',
                padding:    '26px 4px',
                fontWeight: 600,
                fontSize:   19,
                color:      '#202124',
              }}
            >
              <span>{item.q}</span>
              <span
                style={{
                  flex:       'none',
                  width:      28,
                  height:     28,
                  borderRadius: 999,
                  background: isOpen ? 'var(--gc-blue-light)' : '#f8f9fa',
                  display:    'grid',
                  placeItems: 'center',
                  transition: 'background 0.2s, transform 0.3s',
                  transform:  isOpen ? 'rotate(45deg)' : 'rotate(0)',
                  color:      '#1967d2',
                }}
              >
                <Plus size={14} strokeWidth={2.6} />
              </span>
            </button>
            <div
              style={{
                overflow:   'hidden',
                maxHeight:  isOpen ? 320 : 0,
                transition: 'max-height 0.35s ease',
              }}
            >
              <div
                style={{
                  padding:   '0 4px 28px',
                  fontSize:  16,
                  lineHeight: 1.7,
                  color:     '#5f6368',
                  maxWidth:  760,
                }}
              >
                {item.a}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
