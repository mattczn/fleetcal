'use client';

/**
 * Reveal — fade + 22px rise on scroll into view.
 *
 * The CSS for the .reveal / .reveal.in class pair lives in
 * globals.css (so the server-rendered HTML is already in the
 * "before" state and never flashes the wrong frame). This
 * component is just the IntersectionObserver wrapper that
 * flips the .in class on intersection.
 *
 * Why the design handoff's prototype uses setInterval + manual
 * tweening is explicitly called out as a sandbox workaround in
 * the design README — don't port that. Real-app pattern is
 * IntersectionObserver, which is what we use here.
 *
 * Honors prefers-reduced-motion: the CSS short-circuits the
 * transition entirely, so this component still mounts but the
 * animation never runs.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

interface RevealProps {
  children:   ReactNode;
  /** Stagger delay in ms applied to the .in class transition. */
  delay?:     number;
  className?: string;
  style?:     CSSProperties;
}

export default function Reveal({
  children,
  delay = 0,
  className = '',
  style,
}: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Already visible on first paint (above the fold) — flip immediately
    // so the user doesn't see a delayed reveal on the hero.
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.96) {
      const t = window.setTimeout(() => setShown(true), delay);
      return () => window.clearTimeout(t);
    }
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const t = window.setTimeout(() => setShown(true), delay);
            observer.disconnect();
            return () => window.clearTimeout(t);
          }
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [delay]);

  return (
    <div
      ref={ref}
      className={`reveal${shown ? ' in' : ''}${className ? ` ${className}` : ''}`}
      style={style}
    >
      {children}
    </div>
  );
}
