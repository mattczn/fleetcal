'use client';

import { useEffect } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';

/**
 * Reconciles the user's theme preference (held in zustand/localStorage)
 * with what the server rendered. The root layout reads the
 * `fleetcal-theme` cookie and applies `data-theme` server-side; this
 * component:
 *
 *   1. Resolves the current preference (handles 'system' via media query)
 *   2. Updates data-theme on <html> if it doesn't match (e.g. preference
 *      stored as 'dark' but cookie was missing and SSR defaulted to 'light')
 *   3. Writes the resolved value back to the cookie so the next SSR is
 *      up-to-date — closes the loop for first visits and 'system' users.
 *   4. Subscribes to OS theme changes when the preference is 'system'.
 */
function writeCookie(resolved: 'light' | 'dark') {
  document.cookie = `fleetcal-theme=${resolved}; path=/; max-age=31536000; samesite=lax`;
}

export default function ThemeProvider() {
  useEffect(() => {
    const { theme } = useCalendarStore.getState();
    const resolved: 'light' | 'dark' = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    if (document.documentElement.getAttribute('data-theme') !== resolved) {
      document.documentElement.setAttribute('data-theme', resolved);
    }
    writeCookie(resolved);

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        if (useCalendarStore.getState().theme === 'system') {
          const next: 'light' | 'dark' = mq.matches ? 'dark' : 'light';
          document.documentElement.setAttribute('data-theme', next);
          writeCookie(next);
        }
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, []);

  return null;
}
