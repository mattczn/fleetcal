'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type OnboardingPhase = 'demo' | 'ready-screen' | 'setup-wizard' | 'complete';

interface OnboardingStore {
  phase: OnboardingPhase;
  tourStep: number;
  completedItems: string[];
  setPhase: (p: OnboardingPhase) => void;
  advanceTour: () => void;
  backTour: () => void;
  completeOnboarding: () => void;
  resetOnboarding: () => void;
  toggleItem: (id: string) => void;
}

export const TOUR_STEPS = [
  {
    target: null,
    title: 'Welcome to Curzon Dispatch',
    body: "We've loaded some demo data so you can see how it works. Take a quick tour to get familiar, then set up your real fleet.",
    cta: "Let's go →",
  },
  {
    target: '[data-tour="calendar-header"]',
    title: 'Your Fleet',
    body: 'Each column is an asset — a truck, driver, or unit. Colors and names are fully customizable.',
    position: 'bottom' as const,
  },
  {
    target: '[data-tour="calendar-grid"]',
    title: 'Load Scheduling',
    body: 'Colored blocks are loads. Click any block to view details, update status, or attach a rate con. Click any empty space to create a new load.',
    position: 'top' as const,
  },
  {
    target: '[data-tour="sidebar"]',
    title: 'Asset & Driver Panel',
    body: 'Add trucks, manage drivers, filter by category, and drag columns to reorder. The mini calendar lets you jump to any date.',
    position: 'right' as const,
  },
  {
    target: '[data-tour="new-load-area"]',
    title: 'Creating Loads',
    body: 'Click New Load to build a load manually. Open any load and drop a rate confirmation PDF to let AI fill in the route, dates, and pay automatically.',
    position: 'bottom' as const,
  },
  {
    target: '[data-tour="new-load-area"]',
    title: 'Batch PDF Import',
    body: 'Click the stack icon to upload up to 10 rate cons at once. AI parses each PDF and queues them for your review before anything is saved.',
    position: 'bottom' as const,
  },
  {
    target: '[data-tour="view-toggle"]',
    title: 'Day & Week Views',
    body: 'Switch between Day view for a detailed look at one day, and Week view to see 7 days at once. Use the arrows or mini calendar to navigate.',
    position: 'bottom' as const,
  },
  {
    target: '[data-tour="trash"]',
    title: 'Recently Deleted',
    body: 'Accidentally deleted a load? Click the trash icon to see deleted loads and restore them with one click. They stay here for 30 days.',
    position: 'bottom' as const,
    cta: "I'm ready →",
  },
] as const;

export const useOnboardingStore = create<OnboardingStore>()(
  persist(
    (set, get) => ({
      phase:          'demo',
      tourStep:       0,
      completedItems: [],

      setPhase: (p) => set({ phase: p }),

      advanceTour: () => {
        const { tourStep } = get();
        const lastStep = TOUR_STEPS.length - 1;
        if (tourStep >= lastStep) {
          set({ phase: 'ready-screen', tourStep: 0 });
        } else {
          set({ tourStep: tourStep + 1 });
        }
      },

      backTour: () => set((s) => ({ tourStep: Math.max(0, s.tourStep - 1) })),

      completeOnboarding: () => set({ phase: 'complete', tourStep: 0 }),

      resetOnboarding: () => set({ phase: 'demo', tourStep: 0, completedItems: [] }),

      toggleItem: (id) => set((s) => ({
        completedItems: s.completedItems.includes(id)
          ? s.completedItems.filter(i => i !== id)
          : [...s.completedItems, id],
      })),
    }),
    {
      name: 'fleetcal-onboarding',
      partialize: (s) => ({
        phase:          s.phase,
        tourStep:       s.tourStep,
        completedItems: s.completedItems,
      }),
    }
  )
);
