'use client';

import { Rocket } from 'lucide-react';
import { useOnboardingStore } from '@/store/useOnboardingStore';
import { useCalendarStore } from '@/store/useCalendarStore';

export default function ReadyScreen() {
  const { setPhase } = useOnboardingStore();
  const exitDemoMode = useCalendarStore(s => s.exitDemoMode);

  const handleStart = () => {
    exitDemoMode();
    setPhase('setup-wizard');
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)' }}
    >
      <div
        className="flex flex-col items-center gap-6 rounded-3xl p-10 text-center"
        style={{
          background:  'var(--gc-surface)',
          boxShadow:   'var(--shadow-3)',
          maxWidth:    480,
          width:       '90vw',
        }}
      >
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: 'var(--gc-blue-light)' }}
        >
          <Rocket size={28} style={{ color: 'var(--gc-blue)' }} />
        </div>

        <div>
          <h2 className="text-2xl font-bold mb-2" style={{ color: 'var(--gc-text-1)' }}>
            Ready to get started?
          </h2>
          <p className="text-[14px] leading-relaxed" style={{ color: 'var(--gc-text-2)' }}>
            The demo data will be cleared and you can set up your real fleet. You can add trucks manually or import from a CSV in seconds.
          </p>
        </div>

        <div className="flex flex-col gap-2 w-full">
          <button
            onClick={handleStart}
            className="w-full py-3 rounded-xl text-[15px] font-semibold text-white"
            style={{ background: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}
          >
            Set up my fleet
          </button>
          <button
            onClick={() => { exitDemoMode(); useOnboardingStore.getState().completeOnboarding(); }}
            className="w-full py-2.5 rounded-xl text-[14px] font-medium"
            style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
