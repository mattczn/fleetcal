'use client';

import { useEffect } from 'react';
import { useModules } from '@/lib/useModules';
import { usePermissions } from '@/lib/usePermissions';
import { usePlannedStore } from '@/store/usePlannedStore';

/**
 * Loads planned placeholders (module: planning) for the calendar, then
 * refreshes on window focus and every 2 minutes so a plan another
 * dispatcher added shows up without a reload — plans have no realtime
 * channel. Renders nothing; does nothing for orgs/roles without access.
 */
export default function PlannedLoader() {
  const { enabled: moduleOn } = useModules();
  const { can } = usePermissions();
  const allowed = moduleOn('planning') && can('planning.access');
  const load = usePlannedStore((s) => s.load);

  useEffect(() => {
    if (!allowed) return;
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener('focus', onFocus);
    const t = setInterval(() => { void load(); }, 120_000);
    return () => { window.removeEventListener('focus', onFocus); clearInterval(t); };
  }, [allowed, load]);

  return null;
}
