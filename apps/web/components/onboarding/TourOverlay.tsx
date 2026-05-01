'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { TOUR_STEPS, useOnboardingStore } from '@/store/useOnboardingStore';

interface SpotlightRect { top: number; left: number; width: number; height: number }

const PAD = 8;

function getRect(selector: string | null): SpotlightRect | null {
  if (!selector) return null;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

export default function TourOverlay() {
  const { tourStep, advanceTour, backTour, setPhase, completeOnboarding } = useOnboardingStore();
  const step = TOUR_STEPS[tourStep];
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  useLayoutEffect(() => {
    // Reset immediately so stale rect from previous step never drives positioning
    setRect(null);

    const update = () => setRect(getRect(step.target ?? null));
    update();

    observerRef.current?.disconnect();
    if (step.target) {
      const el = document.querySelector(step.target);
      if (el) {
        observerRef.current = new ResizeObserver(update);
        observerRef.current.observe(el);
      }
    }
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      observerRef.current?.disconnect();
    };
  }, [tourStep, step.target]);

  const hasTarget  = !!step.target;
  const isCentered = !hasTarget || !rect;
  const vw = typeof window !== 'undefined' ? window.innerWidth  : 1440;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;

  // Welcome step gets a large centered card; tour steps use a compact positioned card
  const cardW   = isCentered ? Math.min(780, vw * 0.88) : 320;
  const cardH   = isCentered ? 260 : 160;   // used only for positioning math on non-centered steps

  let tipTop = 0, tipLeft = 0;

  if (!isCentered && rect) {
    const pos = 'position' in step ? step.position : 'bottom';
    if (pos === 'bottom') {
      tipTop  = rect.top + rect.height + 16;
      tipLeft = Math.min(Math.max(rect.left + rect.width / 2 - cardW / 2, 12), vw - cardW - 12);
    } else if (pos === 'top') {
      tipTop  = rect.top - cardH - 16;
      tipLeft = Math.min(Math.max(rect.left + rect.width / 2 - cardW / 2, 12), vw - cardW - 12);
    } else if (pos === 'right') {
      tipTop  = Math.min(Math.max(rect.top + rect.height / 2 - cardH / 2, 12), vh - cardH - 12);
      tipLeft = Math.min(rect.left + rect.width + 16, vw - cardW - 12);
    }

    // Keep card within viewport vertically for bottom/top
    if ('position' in step && step.position === 'bottom') {
      tipTop = Math.min(tipTop, vh - cardH - 12);
    }
    if ('position' in step && step.position === 'top') {
      tipTop = Math.max(tipTop, 12);
    }
  }

  // Don't render positioned card until rect is ready (prevents flash at wrong coords)
  const showCard = isCentered || rect !== null;

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      {/* Backdrop — blocks clicks only on the welcome step; tour steps are click-through */}
      {isCentered && (
        <div
          className="absolute inset-0 pointer-events-auto"
          style={{ background: 'rgba(0,0,0,0.6)' }}
        />
      )}

      {/* Spotlight cutout — its box-shadow darkens everything outside the target */}
      {rect && (
        <div
          className="absolute pointer-events-none"
          style={{
            top:          rect.top,
            left:         rect.left,
            width:        rect.width,
            height:       rect.height,
            borderRadius: 10,
            boxShadow:    '0 0 0 9999px rgba(0,0,0,0.52)',
            outline:      '2px solid rgba(26,115,232,0.7)',
            background:   'transparent',
            zIndex:       1,
          }}
        />
      )}

      {/* Card */}
      {showCard && (
        <div
          className="absolute pointer-events-auto"
          style={isCentered ? {
            top:       '50%',
            left:      '50%',
            transform: 'translate(-50%,-50%)',
            width:     cardW,
            zIndex:    2,
          } : {
            top:    tipTop,
            left:   tipLeft,
            width:  cardW,
            zIndex: 2,
          }}
        >
          <div
            className="rounded-2xl flex flex-col gap-4"
            style={{
              background: 'var(--gc-surface)',
              boxShadow:  'var(--shadow-3)',
              border:     '1px solid var(--gc-border)',
              padding:    isCentered ? '36px 40px 32px' : '20px',
            }}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-2">
              <span
                style={{
                  color:      'var(--gc-text-1)',
                  fontSize:   isCentered ? 22 : 15,
                  fontWeight: 700,
                  lineHeight: 1.25,
                }}
              >
                {step.title}
              </span>
              <button
                onClick={() => { setPhase('complete'); completeOnboarding(); }}
                className="shrink-0 p-1 rounded-full -mt-1 -mr-1"
                style={{ color: 'var(--gc-text-3)' }}
                onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title="Skip tour"
              >
                <X size={isCentered ? 18 : 14} />
              </button>
            </div>

            <p
              style={{
                color:      'var(--gc-text-2)',
                fontSize:   isCentered ? 15 : 13,
                lineHeight: 1.6,
              }}
            >
              {step.body}
            </p>

            {/* Footer */}
            <div className="flex items-center justify-between" style={{ marginTop: isCentered ? 8 : 4 }}>
              {/* Step dots */}
              <div className="flex items-center gap-1.5">
                {TOUR_STEPS.map((_, i) => (
                  <div
                    key={i}
                    className="rounded-full transition-all"
                    style={{
                      width:      i === tourStep ? 18 : 6,
                      height:     6,
                      background: i === tourStep ? 'var(--gc-blue)' : 'var(--gc-border)',
                    }}
                  />
                ))}
              </div>

              {/* Buttons */}
              <div className="flex items-center gap-2">
                {tourStep > 0 && (
                  <button
                    onClick={backTour}
                    className="rounded-lg font-medium"
                    style={{
                      border:     '1px solid var(--gc-border)',
                      color:      'var(--gc-text-2)',
                      background: 'var(--gc-surface)',
                      fontSize:   isCentered ? 14 : 13,
                      padding:    isCentered ? '8px 18px' : '6px 12px',
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-surface)')}
                  >
                    Back
                  </button>
                )}
                <button
                  onClick={advanceTour}
                  className="rounded-lg font-semibold text-white"
                  style={{
                    background: 'var(--gc-blue)',
                    fontSize:   isCentered ? 14 : 13,
                    padding:    isCentered ? '10px 28px' : '6px 16px',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}
                >
                  {'cta' in step ? step.cta : 'Next →'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
