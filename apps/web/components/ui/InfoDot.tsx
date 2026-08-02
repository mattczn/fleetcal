'use client';

import { Info } from 'lucide-react';
import type { ReactNode } from 'react';

import Tooltip from '@/components/ui/Tooltip';

/**
 * Small ⓘ that reveals an explainer on hover.
 *
 * The house style for "how is this number derived?" — the kind of thing
 * that used to sit as a permanent grey footnote under a chart. Prose
 * that explains a calculation is read once and then becomes noise, so
 * it belongs one hover away rather than in the layout. Anything the
 * user needs at a GLANCE (a value, a unit, a status) still goes on the
 * page — this is only for the explanation behind it.
 *
 * Prefer this over a native `title=""`: the browser's tooltip takes
 * ~1s to appear, can't be styled, and truncates long text on some
 * platforms.
 */
export default function InfoDot({
  content,
  size = 11,
  placement = 'bottom',
  label = 'How this is calculated',
}: {
  content: ReactNode;
  /** Icon size in px. 11 matches the KPI tiles; 12 reads better beside
   *  a card heading. */
  size?: number;
  placement?: 'top' | 'bottom';
  /** Screen-reader label for the trigger. Override when a more specific
   *  description fits ("How relay revenue is split"). */
  label?: string;
}) {
  return (
    <Tooltip content={content} placement={placement}>
      <Info
        size={size}
        aria-label={label}
        role="img"
        // tabIndex so keyboard users can reach the explainer — Tooltip
        // already opens on focus, it just needs something focusable.
        tabIndex={0}
        style={{ color: 'var(--gc-text-3)', opacity: 0.6, cursor: 'help', outlineOffset: 2 }}
      />
    </Tooltip>
  );
}
