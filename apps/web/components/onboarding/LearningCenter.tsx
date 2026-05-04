'use client';

import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import Tooltip from '@/components/ui/Tooltip';
import { LEARNING_MODULES, ALL_STEP_IDS } from '@/lib/learningModules';
import { useOnboardingStore } from '@/store/useOnboardingStore';

function ProgressRing({ pct, size = 36, stroke = 3 }: { pct: number; size?: number; stroke?: number }) {
  const r = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const dash = circ * pct;
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gc-border)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--gc-blue)" strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 400ms ease' }} />
    </svg>
  );
}

export default function LearningCenter() {
  const { completedItems, toggleItem, phase } = useOnboardingStore();
  const [open, setOpen]   = useState(false);
  const [expanded, setExpanded] = useState<string | null>(LEARNING_MODULES[0].id);
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on outside click — must be before any early return
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Don't render during active onboarding (after all hooks)
  if (phase !== 'complete') return null;

  const totalSteps     = ALL_STEP_IDS.length;
  const completedCount = completedItems.filter(id => ALL_STEP_IDS.includes(id)).length;
  const pct            = totalSteps > 0 ? completedCount / totalSteps : 0;

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Trigger button */}
      <Tooltip content="Tutorials" placement="bottom">
        <button
          onClick={() => setOpen(o => !o)}
          className="flex items-center justify-center w-9 h-9 rounded-full transition-colors relative"
          style={{
            color:      open ? 'var(--gc-blue)' : 'var(--gc-text-2)',
            background: open ? 'var(--gc-blue-light)' : 'transparent',
          }}
          onMouseOver={e => { if (!open) e.currentTarget.style.background = 'var(--gc-hover)'; }}
          onMouseOut={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
        >
          <BookOpen size={17} />
          {completedCount < totalSteps && (
            <span
              className="absolute bottom-1 right-1 rounded-full"
              style={{ width: 7, height: 7, background: 'var(--gc-blue)', border: '1.5px solid var(--gc-surface)' }}
            />
          )}
        </button>
      </Tooltip>

      {/* Panel */}
      {open && (
        <div
          className="absolute flex flex-col overflow-hidden"
          style={{
            top:          'calc(100% + 8px)',
            right:        0,
            width:        360,
            maxHeight:    '80vh',
            borderRadius: 14,
            boxShadow:    'var(--shadow-3)',
            border:       '1px solid var(--gc-border)',
            background:   'var(--gc-surface)',
            zIndex:       200,
          }}
        >
          {/* Header */}
          <div className="shrink-0 flex items-center gap-3 px-4 py-3.5"
            style={{ borderBottom: '1px solid var(--gc-border)' }}>
            <ProgressRing pct={pct} size={38} stroke={3.5} />
            <div className="flex-1 min-w-0">
              <p className="text-[14px] font-semibold" style={{ color: 'var(--gc-text-1)' }}>
                Get started with FleetCal
              </p>
              <p className="text-[12px]" style={{ color: 'var(--gc-text-3)' }}>
                {completedCount} of {totalSteps} completed
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-full shrink-0"
              style={{ color: 'var(--gc-text-3)' }}
              onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
            >
              <X size={14} />
            </button>
          </div>

          {/* Modules */}
          <div className="overflow-y-auto">
            {LEARNING_MODULES.map((mod) => {
              const modCompleted = mod.steps.filter(s => completedItems.includes(s.id)).length;
              const isExpanded   = expanded === mod.id;
              const allDone      = modCompleted === mod.steps.length;

              return (
                <div key={mod.id} style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
                  {/* Module header */}
                  <button
                    onClick={() => setExpanded(isExpanded ? null : mod.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 transition-colors"
                    style={{ background: 'transparent' }}
                    onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                    onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    {/* Module progress dot / check */}
                    <div
                      className="shrink-0 flex items-center justify-center rounded-full"
                      style={{
                        width:      22,
                        height:     22,
                        background: allDone ? '#16a34a' : modCompleted > 0 ? 'var(--gc-blue-light)' : 'var(--gc-bg)',
                        border:     `1.5px solid ${allDone ? '#16a34a' : modCompleted > 0 ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                      }}
                    >
                      {allDone
                        ? <Check size={12} color="white" />
                        : modCompleted > 0
                          ? <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--gc-blue)' }}>
                              {modCompleted}/{mod.steps.length}
                            </span>
                          : null}
                    </div>

                    <div className="flex-1 text-left min-w-0">
                      <p className="text-[13px] font-medium truncate"
                        style={{ color: allDone ? 'var(--gc-text-3)' : 'var(--gc-text-1)', textDecoration: allDone ? 'line-through' : 'none' }}>
                        {mod.title}
                      </p>
                      {!allDone && (
                        <p className="text-[11px]" style={{ color: 'var(--gc-text-3)' }}>
                          {modCompleted} of {mod.steps.length} done
                        </p>
                      )}
                    </div>

                    {isExpanded
                      ? <ChevronUp size={14} className="shrink-0" style={{ color: 'var(--gc-text-3)' }} />
                      : <ChevronDown size={14} className="shrink-0" style={{ color: 'var(--gc-text-3)' }} />}
                  </button>

                  {/* Steps */}
                  {isExpanded && (
                    <div className="pb-2" style={{ paddingLeft: 16, paddingRight: 16 }}>
                      {mod.steps.map((step) => {
                        const done = completedItems.includes(step.id);
                        return (
                          <button
                            key={step.id}
                            onClick={() => toggleItem(step.id)}
                            className="w-full flex items-start gap-2.5 py-2 px-2 rounded-lg text-left transition-colors"
                            style={{ background: 'transparent' }}
                            onMouseOver={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                            onMouseOut={e => (e.currentTarget.style.background = 'transparent')}
                          >
                            {/* Checkbox */}
                            <div
                              className="shrink-0 flex items-center justify-center rounded"
                              style={{
                                marginTop:  2,
                                width:      16,
                                height:     16,
                                background: done ? 'var(--gc-blue)' : 'transparent',
                                border:     `1.5px solid ${done ? 'var(--gc-blue)' : 'var(--gc-border)'}`,
                              }}
                            >
                              {done && <Check size={10} color="white" strokeWidth={3} />}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p
                                className="text-[12px] font-medium leading-snug"
                                style={{
                                  color:          done ? 'var(--gc-text-3)' : 'var(--gc-text-1)',
                                  textDecoration: done ? 'line-through' : 'none',
                                }}
                              >
                                {step.label}
                              </p>
                              {step.hint && (
                                <p className="text-[11px] leading-snug mt-0.5" style={{ color: 'var(--gc-text-3)' }}>
                                  {step.hint}
                                </p>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
