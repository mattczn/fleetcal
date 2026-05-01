'use client';

import { useEffect } from 'react';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function ThemeProvider() {
  useEffect(() => {
    const { theme } = useCalendarStore.getState();
    const resolved = theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    document.documentElement.setAttribute('data-theme', resolved);

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        if (useCalendarStore.getState().theme === 'system') {
          document.documentElement.setAttribute('data-theme', mq.matches ? 'dark' : 'light');
        }
      };
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, []);

  return null;
}
