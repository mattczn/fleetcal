'use client';

import { useEffect, useRef } from 'react';
import { useAuth } from '@clerk/nextjs';
import { fetchOrgData, fetchSavedLocations } from '@/lib/db';
import { useCalendarStore } from '@/store/useCalendarStore';
import { useOnboardingStore } from '@/store/useOnboardingStore';

export default function DataLoader() {
  const { orgId } = useAuth();
  const hydrate              = useCalendarStore((s) => s.hydrate);
  const hydrateDemoMode      = useCalendarStore((s) => s.hydrateDemoMode);
  const loadSavedLocations   = useCalendarStore((s) => s.fetchSavedLocations);
  const loadDispatchers      = useCalendarStore((s) => s.fetchDispatchers);
  const loadCustomers        = useCalendarStore((s) => s.fetchCustomers);
  const loadTrailers         = useCalendarStore((s) => s.fetchTrailers);
  const autoExpireTrash      = useCalendarStore((s) => s.autoExpireTrash);
  const { phase, completeOnboarding, setPhase } = useOnboardingStore();
  const loadedId = useRef<string | null>(null);

  useEffect(() => {
    if (!orgId || loadedId.current === orgId) return;
    loadedId.current = orgId;

    const today = new Date();
    const windowStart = new Date(today);
    windowStart.setDate(today.getDate() - 21);
    const windowEnd = new Date(today);
    windowEnd.setDate(today.getDate() + 7);
    const loadedStart = windowStart.toISOString();
    const loadedEnd   = windowEnd.toISOString();

    fetchOrgData(orgId, loadedStart, loadedEnd)
      .then((data) => {
        if (data.assets.length === 0 && phase !== 'complete') {
          // New org with no data — show onboarding with demo data
          hydrate({ orgId, ...data, loadedStart, loadedEnd }); // sets orgId in store
          hydrateDemoMode();
          setPhase('demo');
        } else {
          // Org has real data — skip onboarding
          hydrate({ orgId, ...data, loadedStart, loadedEnd });
          if (phase !== 'complete') completeOnboarding();
        }
        void loadSavedLocations();
        void loadDispatchers();
        void loadCustomers();
        void loadTrailers();
        autoExpireTrash();
      })
      .catch((err) => console.error('[DataLoader] fetch failed:', err));
  }, [orgId, hydrate, hydrateDemoMode, loadSavedLocations, loadDispatchers, loadCustomers, loadTrailers, autoExpireTrash, phase, completeOnboarding, setPhase]);

  return null;
}
