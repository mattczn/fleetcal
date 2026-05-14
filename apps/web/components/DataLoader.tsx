'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';
import { fetchOrgData } from '@/lib/db';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';

export default function DataLoader() {
  const { orgId } = useAuth();
  const hydrate              = useCalendarStore((s) => s.hydrate);
  const hydrateDemoMode      = useCalendarStore((s) => s.hydrateDemoMode);
  const extendLoadedRange    = useCalendarStore((s) => s.extendLoadedRange);
  const loadSavedLocations   = useCalendarStore((s) => s.fetchSavedLocations);
  const loadDispatchers      = useCalendarStore((s) => s.fetchDispatchers);
  const loadCustomers        = useCalendarStore((s) => s.fetchCustomers);
  const loadTrailers         = useCalendarStore((s) => s.fetchTrailers);
  const hydrateRateConSettings = useCalendarStore((s) => s.hydrateRateConSettings);
  const hydrateRoleOverrides = useCalendarStore((s) => s.hydrateRoleOverrides);
  const hydrateOrgModules    = useCalendarStore((s) => s.hydrateOrgModules);
  const autoExpireTrash      = useCalendarStore((s) => s.autoExpireTrash);
  const { phase, completeOnboarding, setPhase } = useOnboardingStore();
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!orgId || loadedId.current === orgId) return;
    loadedId.current = orgId;

    // Two-stage load: today's loads first (small payload, page paints
    // with real data fast), then extend out to a 28-day window in the
    // background for trash + nav across weeks.
    const today = new Date();
    const dayStart = new Date(today); dayStart.setHours(0, 0, 0, 0);
    const dayEnd   = new Date(today); dayEnd.setHours(23, 59, 59, 999);
    const stage1Start = dayStart.toISOString();
    const stage1End   = dayEnd.toISOString();

    const windowStart = new Date(today); windowStart.setDate(today.getDate() - 21);
    const windowEnd   = new Date(today); windowEnd.setDate(today.getDate() + 7);
    const stage2Start = windowStart.toISOString();
    const stage2End   = windowEnd.toISOString();

    fetchOrgData(orgId, stage1Start, stage1End)
      .then((data) => {
        if (data.assets.length === 0 && phase !== 'complete') {
          hydrate({ orgId, ...data, loadedStart: stage1Start, loadedEnd: stage1End });
          hydrateDemoMode();
          setPhase('demo');
        } else {
          hydrate({ orgId, ...data, loadedStart: stage1Start, loadedEnd: stage1End });
          if (phase !== 'complete') completeOnboarding();
        }
        // Reference data — not blocking the calendar paint
        void loadSavedLocations();
        void loadDispatchers();
        void loadCustomers();
        void loadTrailers();
        // Org-scoped rate-con AI settings — hydrate so /api/parse-ratecon
        // calls and the EventModal field rendering see this org's config
        // instead of localStorage defaults.
        void import('@/lib/railway').then(({ railway }) => railway.getOrgSettings())
          .then(({ settings }) => {
            hydrateRateConSettings(settings.rateConSettings);
            hydrateRoleOverrides(settings.roleOverrides);
            hydrateOrgModules(settings.orgModules);
          })
          .catch((err) => console.error('[DataLoader] org settings fetch failed:', err));
        autoExpireTrash();
        // Stage 2: extend the events window in the background. Merges by id,
        // updates loadedStart/loadedEnd in the store.
        void extendLoadedRange(stage2Start, stage2End);
      })
      .catch((err) => console.error('[DataLoader] fetch failed:', err));
  }, [orgId, hydrate, hydrateDemoMode, extendLoadedRange, loadSavedLocations, loadDispatchers, loadCustomers, loadTrailers, hydrateRateConSettings, hydrateRoleOverrides, hydrateOrgModules, autoExpireTrash, phase, completeOnboarding, setPhase]);

  return null;
}
