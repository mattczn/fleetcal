'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** ms before showing on hover. Default 300. */
  delay?: number;
  /** Where the tooltip floats relative to the trigger. Default 'top'. */
  placement?: 'top' | 'bottom';
}

/**
 * Hover tooltip rendered into a body portal so it can't be clipped by
 * any ancestor's overflow/transform/z-index. Positioned via fixed
 * coordinates derived from the trigger's bounding rect.
 */
export default function Tooltip({ content, children, delay = 300, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setVisible(true), delay);
  };
  const onLeave = () => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    setVisible(false);
  };

  // Position the floating bubble relative to the trigger every time it
  // becomes visible (and on subsequent mutations of the bubble's size).
  useLayoutEffect(() => {
    if (!visible) { setCoords(null); return; }
    const compute = () => {
      const trigger = triggerRef.current;
      const tip     = tooltipRef.current;
      if (!trigger || !tip) return;
      const tr = trigger.getBoundingClientRect();
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const gap = 6;
      const top  = placement === 'top' ? tr.top - th - gap : tr.bottom + gap;
      const left = tr.left + tr.width / 2 - tw / 2;
      // Clamp to viewport so the bubble never falls off-screen.
      const clampedLeft = Math.max(8, Math.min(window.innerWidth - tw - 8, left));
      setCoords({ top, left: clampedLeft });
    };
    compute();
    // Re-compute on scroll/resize while visible.
    const onScroll = () => compute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [visible, placement, content]);

  useEffect(() => () => {
    if (showTimer.current) clearTimeout(showTimer.current);
  }, []);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        style={{ display: 'inline-flex', alignItems: 'center' }}
      >
        {children}
      </span>
      {visible && typeof document !== 'undefined' && createPortal(
        <span
          ref={tooltipRef}
          role="tooltip"
          style={{
            position: 'fixed',
            top: coords?.top ?? -9999,
            left: coords?.left ?? -9999,
            zIndex: 9999,
            pointerEvents: 'none',
            background: 'rgba(32, 33, 36, 0.95)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 500,
            lineHeight: 1.35,
            padding: '6px 10px',
            borderRadius: 6,
            whiteSpace: 'normal',
            maxWidth: 280,
            width: 'max-content',
            boxShadow: '0 2px 8px rgba(0,0,0,.25)',
            // Hide until coords are computed in the layout effect (one paint)
            opacity: coords ? 1 : 0,
            transition: 'opacity 80ms',
          }}
        >
          {content}
        </span>,
        document.body,
      )}
    </>
  );
}
