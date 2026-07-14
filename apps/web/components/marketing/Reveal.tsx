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
    let cancelled = false;
    let observer: IntersectionObserver | null = null;
    const show = () => {
      window.setTimeout(() => { if (!cancelled) setShown(true); }, delay);
    };

    const arm = () => {
      if (cancelled || !el) return;
      const vh = window.innerHeight || document.documentElement.clientHeight || 0;
      const rect = el.getBoundingClientRect();
      // Above the fold, or a viewport we cannot measure yet: reveal now so
      // hero content never sits blank waiting on an observer that may not fire.
      if (!vh || rect.top < vh * 0.96) {
        show();
        return;
      }
      observer = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              show();
              observer?.disconnect();
              return;
            }
          }
        },
        { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
      );
      observer.observe(el);
    };

    // A link opened from an email frequently hydrates in a hidden/background
    // tab, where layout and IntersectionObserver are unreliable and above-the-
    // fold content can get stuck at opacity 0 (the blank-hero bug). Wait until
    // the tab is actually visible before arming the reveal.
    if (document.visibilityState === 'visible') {
      arm();
    } else {
      const onVisible = () => {
        if (document.visibilityState === 'visible') {
          document.removeEventListener('visibilitychange', onVisible);
          arm();
        }
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        cancelled = true;
        document.removeEventListener('visibilitychange', onVisible);
        observer?.disconnect();
      };
    }

    return () => {
      cancelled = true;
      observer?.disconnect();
    };
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
