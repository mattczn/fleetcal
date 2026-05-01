'use client';

import { useOnboardingStore } from '@/store/useOnboardingStore';
import TourOverlay from './TourOverlay';
import ReadyScreen from './ReadyScreen';
import SetupWizard from './SetupWizard';

export default function OnboardingController() {
  const { phase } = useOnboardingStore();

  if (phase === 'demo') return <TourOverlay />;
  if (phase === 'ready-screen') return <ReadyScreen />;
  if (phase === 'setup-wizard') return <SetupWizard />;
  return null;
}
