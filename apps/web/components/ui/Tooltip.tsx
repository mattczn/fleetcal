'use client';

import { useRef, useState, type ReactNode } from 'react';

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /** ms before showing on hover. Default 300. */
  delay?: number;
  /** Where the tooltip floats relative to the trigger. Default 'top'. */
  placement?: 'top' | 'bottom';
}

/**
 * Lightweight hover tooltip — pure JS state, no external lib. Renders the
 * trigger as an inline-block wrapper and positions the floating bubble
 * absolutely. Use anywhere a `title` attribute would normally go but you
 * want a more reliable, instantly-styled tooltip.
 */
export default function Tooltip({ content, children, delay = 300, placement = 'top' }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onEnter = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => setVisible(true), delay);
  };
  const onLeave = () => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null; }
    setVisible(false);
  };

  const positionStyle: React.CSSProperties = placement === 'top'
    ? { bottom: '100%', marginBottom: 6 }
    : { top: '100%', marginTop: 6 };

  return (
    <span
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onFocus={onEnter}
      onBlur={onLeave}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            left: '50%',
            transform: 'translateX(-50%)',
            ...positionStyle,
            zIndex: 100,
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
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}
