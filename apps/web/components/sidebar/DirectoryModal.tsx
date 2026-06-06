'use client';

/**
 * DirectoryModal — unified directory shell for the 5 fleet entities.
 *
 * Replaces the prior "one button per directory" sidebar pattern with
 * a single tabbed surface so dispatchers can hop between fleet
 * entities without closing + reopening modals.
 *
 * Current state (2026-06-06):
 *   - Trucks  → AssetsModal embedded (rendered inline as a directory body)
 *   - Drivers / Trailers / Customers / Locations → tab opens the
 *     existing standalone modal on top of this shell. The embedded
 *     refactor for each will land in follow-up commits; this gets
 *     the unified-entry-point UX shipping today.
 */

import { useRef, useState } from 'react';
import { X, Truck, Container, Users, Building2, MapPin } from 'lucide-react';
import AssetsModal from './AssetsModal';
import TrailersModal from './TrailersModal';
import DriversModal from './DriversModal';
import BrokerProfileModal from '@/components/brokers/BrokerProfileModal';
import SavedLocationsDirectoryBody from './SavedLocationsDirectoryBody';
import { useModules } from '@/lib/useModules';

export type DirectoryTab = 'drivers' | 'trucks' | 'trailers' | 'customers' | 'locations';

export interface DirectoryDetailHandle {
  isDirty: () => boolean;
  save:    () => Promise<void>;
  discard: () => void;
}

interface Props {
  /** Which tab to open on initially. */
  initial: DirectoryTab;
  onClose: () => void;
}

const TAB_META: Record<DirectoryTab, { label: string; icon: typeof Truck }> = {
  drivers:   { label: 'Drivers',   icon: Users },
  trucks:    { label: 'Trucks',    icon: Truck },
  trailers:  { label: 'Trailers',  icon: Container },
  customers: { label: 'Customers', icon: Building2 },
  locations: { label: 'Locations', icon: MapPin },
};

export default function DirectoryModal({ initial, onClose }: Props) {
  const [tab, setTab] = useState<DirectoryTab>(initial);
  const [showUnsaved, setShowUnsaved] = useState(false);
  const [saving, setSaving]           = useState(false);
  const pendingActionRef = useRef<(() => void) | null>(null);

  // Module gate — only show Trailers tab if the org has the module.
  const { enabled: moduleEnabled } = useModules();
  const trailersOn = moduleEnabled('trailers');

  // Embedded refs — Trucks + Customers track dirty state via their
  // imperative handles; Drivers + Trailers auto-save so their
  // handles are no-ops. Locations is still transitional.
  const trucksRef    = useRef<DirectoryDetailHandle>(null);
  const driversRef   = useRef<DirectoryDetailHandle>(null);
  const trailersRef  = useRef<DirectoryDetailHandle>(null);
  const customersRef = useRef<DirectoryDetailHandle>(null);

  const currentRef = (): DirectoryDetailHandle | null => {
    if (tab === 'trucks')    return trucksRef.current;
    if (tab === 'drivers')   return driversRef.current;
    if (tab === 'trailers')  return trailersRef.current;
    if (tab === 'customers') return customersRef.current;
    return null;
  };

  const tryNavigate = (action: () => void) => {
    if (currentRef()?.isDirty()) {
      pendingActionRef.current = action;
      setShowUnsaved(true);
    } else {
      action();
    }
  };

  const handleClose     = () => tryNavigate(onClose);
  const handleSelectTab = (next: DirectoryTab) => tryNavigate(() => setTab(next));

  const handleUnsavedSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await currentRef()?.save();
      const action = pendingActionRef.current;
      pendingActionRef.current = null;
      setShowUnsaved(false);
      action?.();
    } catch (err) {
      console.error('[DirectoryModal] save failed:', err);
      alert(`Save failed: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };
  const handleUnsavedDiscard = () => {
    currentRef()?.discard();
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    setShowUnsaved(false);
    action?.();
  };
  const handleUnsavedKeep = () => {
    pendingActionRef.current = null;
    setShowUnsaved(false);
  };

  const visibleTabs: DirectoryTab[] = [
    'drivers',
    'trucks',
    ...(trailersOn ? (['trailers'] as DirectoryTab[]) : []),
    'customers',
    'locations',
  ];

  return (
    <>
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.32)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) handleClose(); }}>
      <div
        className="flex flex-col relative"
        style={{
          background: 'var(--gc-surface)',
          width: '100%', maxWidth: 1120, height: '86vh',
          borderRadius: 14, boxShadow: 'var(--shadow-3)', overflow: 'hidden',
        }}>

        {showUnsaved && (
          <div className="absolute inset-0 z-20 flex items-center justify-center"
            style={{ background: 'rgba(0,0,0,0.4)', borderRadius: 14 }}>
            <div className="rounded-2xl p-6 space-y-4"
              style={{ background: 'var(--gc-surface)', boxShadow: 'var(--shadow-3)', width: 380, border: '1px solid var(--gc-border-light)' }}>
              <div>
                <div className="text-base font-semibold mb-1" style={{ color: 'var(--gc-text-1)' }}>Save changes?</div>
                <div className="text-sm" style={{ color: 'var(--gc-text-2)' }}>You have unsaved changes on this {tab.slice(0, -1)}.</div>
              </div>
              <div className="flex flex-col gap-2">
                <button onClick={() => void handleUnsavedSave()} disabled={saving}
                  className="w-full px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-60"
                  style={{ background: 'var(--gc-blue)' }}>
                  {saving ? 'Saving…' : 'Yes, save changes'}
                </button>
                <button onClick={handleUnsavedDiscard} disabled={saving}
                  className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
                  style={{ border: '1px solid var(--gc-border)', color: 'var(--gc-text-2)', background: 'transparent' }}>
                  No, discard changes
                </button>
                <button onClick={handleUnsavedKeep} disabled={saving}
                  className="w-full px-4 py-2.5 rounded-xl text-sm font-medium transition-colors disabled:opacity-60"
                  style={{ color: 'var(--gc-text-3)', background: 'transparent' }}>
                  Keep editing
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header — tab strip + close X */}
        <div className="shrink-0 flex items-center justify-between px-5 py-3"
          style={{ borderBottom: '1px solid var(--gc-border-light)', background: 'var(--gc-bg)' }}>
          <div className="flex items-center gap-1">
            {visibleTabs.map(t => {
              const Icon = TAB_META[t].icon;
              const active = tab === t;
              return (
                <button
                  key={t}
                  onClick={() => handleSelectTab(t)}
                  className="flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-semibold transition-colors"
                  style={{
                    background: active ? 'var(--gc-surface)' : 'transparent',
                    color:      active ? 'var(--gc-blue)' : 'var(--gc-text-2)',
                    boxShadow:  active ? '0 1px 2px rgba(0,0,0,0.06), 0 0 0 1px var(--gc-border-light)' : 'none',
                  }}
                  onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
                  onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
                  <Icon size={15} />
                  {TAB_META[t].label}
                </button>
              );
            })}
          </div>
          <button onClick={handleClose} className="p-1.5 rounded-full transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
          {tab === 'trucks'    && <AssetsModal        ref={trucksRef}    embedded onClose={onClose} />}
          {tab === 'drivers'   && <DriversModal       ref={driversRef}   embedded onClose={onClose} />}
          {tab === 'trailers'  && trailersOn && <TrailersModal ref={trailersRef} embedded onClose={onClose} />}
          {tab === 'customers' && <BrokerProfileModal ref={customersRef} embedded onClose={onClose} />}
          {tab === 'locations' && <SavedLocationsDirectoryBody />}
        </div>
      </div>
    </div>
    </>
  );
}

