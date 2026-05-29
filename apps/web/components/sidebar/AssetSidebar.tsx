'use client';

import { useState, useRef } from 'react';
import { Plus, Layers, Truck, Users, Menu, Settings, BarChart2, LayoutDashboard, FileCheck2, Receipt, Package, Gauge } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useOrganization } from '@clerk/nextjs';
import { useCalendarStore, BatchItem } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import DriversModal from './DriversModal';
import AssetsModal from './AssetsModal';
import MiniCalendar from './MiniCalendar';
import type { Capability, OrgModule } from '@fleetcal/types';

export default function AssetSidebar() {
  // The truck/asset list itself has moved to the right-hand TruckFleetPanel
  // (opened from the toolbar Truck icon). This sidebar still owns the
  // dispatcher's daily tools — New Load / Batch, MiniCalendar, category
  // filter chips — plus the cross-page nav rail that used to live in
  // AppSidebar. The Manage Assets / Manage Drivers / Settings buttons
  // at the bottom remain the doorway into the directory modals.
  const { openCreateModal, sidebarOpen, toggleSidebar, assetCategories, activeCategoryFilter, setActiveCategoryFilter, startBatch, setBatchParseState, clearBatch, fieldSettings, promptInstructions, promptVariables } = useCalendarStore();
  const { organization } = useOrganization();
  const [showDrivers, setShowDrivers] = useState(false);
  const [showAssets,  setShowAssets]  = useState(false);
  const [batchHovered, setBatchHovered] = useState(false);
  const batchFileInputRef = useRef<HTMLInputElement>(null);

  const handleBatchFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const fileArray = Array.from(files);
    setBatchParseState(0, fileArray.length);
    const items: BatchItem[] = [];
    for (let i = 0; i < fileArray.length; i++) {
      if (useCalendarStore.getState().batchCancelRequested) {
        setBatchParseState(0, 0);
        clearBatch();
        return;
      }
      const file = fileArray[i];
      if (file.type !== 'application/pdf') { setBatchParseState(i + 1, fileArray.length); continue; }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const base64 = dataUrl.split(',')[1];
      try {
        const res = await fetch('/api/parse-ratecon', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            data: base64,
            enabledFields: Object.keys(fieldSettings).filter(k => fieldSettings[k]),
            customInstructions: promptInstructions,
            promptVariables,
            customers: useCalendarStore.getState().customers.map(c => ({
              name: c.name, aliases: c.aliases ?? [], parseHints: c.parseHints,
            })),
          }),
        });
        const json = await res.json();
        items.push({ rateConPdf: dataUrl, parsed: json.error ? {} : json });
      } catch {
        items.push({ rateConPdf: dataUrl, parsed: {} });
      }
      setBatchParseState(i + 1, fileArray.length);
    }

    if (useCalendarStore.getState().batchCancelRequested) {
      setBatchParseState(0, 0);
      clearBatch();
      return;
    }

    const wasMinimized = useCalendarStore.getState().batchMinimized;
    setBatchParseState(0, 0);
    if (items.length > 0) {
      startBatch(items);
      // Only auto-open if the user left the overlay up (didn't click Keep Working)
      if (!wasMinimized) {
        openCreateModal();
      }
    }
  };

  return (
    <>
      <aside
        data-tour="sidebar"
        className="flex flex-col h-full shrink-0 overflow-hidden"
        style={{
          background: 'var(--gc-surface)',
          width: sidebarOpen ? 256 : 0,
          borderRight: sidebarOpen ? '1px solid var(--gc-border)' : 'none',
          transition: 'width 200ms ease, border 200ms ease',
        }}
      >
        {/* Branding header — aligns with toolbar height */}
        <div
          className="shrink-0 flex items-center gap-2 px-3"
          style={{ height: 64, borderBottom: '1px solid var(--gc-border)' }}
        >
          <button
            onClick={toggleSidebar}
            className="p-2 rounded-full transition-colors shrink-0"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Menu size={20} />
          </button>
          <div className="flex items-center gap-2">
            {organization?.imageUrl
              ? <img src={organization.imageUrl} alt="" className="w-8 h-8 rounded-lg shrink-0 object-cover" />
              : <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-[11px] font-bold shrink-0" style={{ background: 'var(--gc-blue)' }}>D</div>
            }
            <span
              className="text-[20px] font-normal tracking-tight whitespace-nowrap"
              style={{ color: 'var(--gc-text-2)', letterSpacing: '-0.3px' }}
            >
              Dispatch
            </span>
          </div>
        </div>

        {/* New Load / Batch Import split button */}
        <div className="px-4 pb-3 shrink-0" style={{ paddingTop: 20, position: 'relative' }}>
          <div data-tour="new-load-area" className="flex rounded-2xl overflow-hidden text-sm font-medium"
            style={{ boxShadow: 'var(--shadow-1)', background: 'var(--gc-surface)' }}>
            <button
              onClick={() => openCreateModal()}
              className="flex items-center gap-2.5 pl-5 pr-4 py-3.5 flex-1 transition-colors"
              style={{ color: 'var(--gc-text-1)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <Plus size={22} style={{ color: 'var(--gc-blue)' }} strokeWidth={2} />
              <span>New Load</span>
            </button>
            <div style={{ width: 1, background: 'var(--gc-border-light)', alignSelf: 'stretch' }} />
            <button
              onClick={() => batchFileInputRef.current?.click()}
              className="flex items-center justify-center px-3.5 transition-colors"
              style={{ color: 'var(--gc-text-3)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-hover)'; e.currentTarget.style.color = 'var(--gc-blue)'; setBatchHovered(true); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--gc-text-3)'; setBatchHovered(false); }}
            >
              <Layers size={16} />
            </button>
            <input
              ref={batchFileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                const files = e.target.files;
                if (files && files.length > 10) { alert('Batch import is limited to 10 PDFs at a time.'); e.target.value = ''; return; }
                handleBatchFiles(files);
                e.target.value = '';
              }}
            />
          </div>
          {batchHovered && (
            <div style={{
              position: 'absolute', bottom: 'calc(100% - 6px)', right: 16,
              background: 'rgba(0,0,0,0.72)', color: 'white',
              fontSize: 11, fontWeight: 600, padding: '3px 8px',
              borderRadius: 6, whiteSpace: 'nowrap', pointerEvents: 'none',
            }}>
              Batch Upload
            </div>
          )}
        </div>

        {/* Mini calendar */}
        <div className="shrink-0" style={{ borderBottom: '1px solid var(--gc-border-light)' }}>
          <MiniCalendar />
        </div>

        {/* Category filter chips */}
        {assetCategories.length > 0 && (
          <div
            className="shrink-0 flex gap-1.5 px-3 py-2 overflow-x-auto"
            style={{ borderBottom: '1px solid var(--gc-border-light)', scrollbarWidth: 'none' }}
          >
            <button
              onClick={() => setActiveCategoryFilter(null)}
              className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
              style={{
                background: activeCategoryFilter === null ? 'var(--gc-blue-light)' : 'transparent',
                color:      activeCategoryFilter === null ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                border: `1px solid ${activeCategoryFilter === null ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
              }}
            >
              All
            </button>
            {assetCategories.map(cat => (
              <button
                key={cat}
                onClick={() => setActiveCategoryFilter(activeCategoryFilter === cat ? null : cat)}
                className="shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-colors"
                style={{
                  background: activeCategoryFilter === cat ? 'var(--gc-blue-light)' : 'transparent',
                  color:      activeCategoryFilter === cat ? 'var(--gc-blue)'       : 'var(--gc-text-3)',
                  border: `1px solid ${activeCategoryFilter === cat ? 'var(--gc-blue)' : 'var(--gc-border-light)'}`,
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        )}

        {/* Cross-page navigation — the dispatcher's jump list to every
            other surface in the app (Dashboard, Closeout, Equipment,
            etc.). The truck list that used to occupy this slot now
            lives in the right-hand TruckFleetPanel (toolbar Truck
            icon), so this rail is the calendar's primary nav surface
            and there's no separate AppSidebar mounted on /calendar.
            Cap + module gates mirror AppSidebar so a role without
            (e.g.) payroll.access doesn't see Payroll here either. */}
        <PageNavSection />

        {/* Manage buttons */}
        <div className="shrink-0 p-3 space-y-0.5" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button
            onClick={() => setShowAssets(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Truck size={16} />
            Manage assets
          </button>
          <button
            onClick={() => setShowDrivers(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-blue)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Users size={16} />
            Manage drivers
          </button>
          <Link
            href="/settings"
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ color: 'var(--gc-text-2)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Settings size={16} />
            Settings
          </Link>
        </div>
      </aside>

      {showAssets  && <AssetsModal    onClose={() => setShowAssets(false)} />}
      {showDrivers && <DriversModal   onClose={() => setShowDrivers(false)} />}
    </>
  );
}

// ── Cross-page nav section ────────────────────────────────────────────
//
// Mirrors AppSidebar's nav list, scoped down for the calendar's
// AssetSidebar shell. Takes the main flex-1 slot (where the truck
// list used to live, before that moved into TruckFleetPanel) so the
// dispatcher can jump to every other surface without a second left
// rail. Calendar itself is intentionally NOT in this list — you're
// already on it, and the brand header doubles as a "you're here" cue.
// Equipment links to the default Maintenance tab; users can switch
// sub-tabs from inside the page.

interface PageNavLink {
  href:    string;
  label:   string;
  icon:    React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  cap:     Capability;
  module?: OrgModule;
  /** Match by prefix when true (so /equipment?tab=fuel still highlights
   *  the Equipment row). Default: exact pathname match. */
  matchPrefix?: boolean;
}

const PAGE_NAV: PageNavLink[] = [
  { href: '/dashboard',  label: 'Dashboard',      icon: BarChart2,       cap: 'dashboard.access' },
  { href: '/board',      label: 'Command Center', icon: LayoutDashboard, cap: 'loads.view' },
  { href: '/closeout',   label: 'Closeout',       icon: FileCheck2,      cap: 'closeout.access',   module: 'closeout' },
  { href: '/accounting', label: 'Accounting',     icon: Receipt,         cap: 'accounting.access', module: 'accounting' },
  { href: '/equipment?tab=maintenance', label: 'Equipment', icon: Package, cap: 'maintenance.access', module: 'maintenance', matchPrefix: true },
  { href: '/payroll',    label: 'Payroll',        icon: Users,           cap: 'payroll.access',    module: 'payroll' },
  { href: '/drivers',    label: 'Drivers',        icon: Gauge,           cap: 'drivers.view' },
];

function PageNavSection() {
  const pathname = usePathname();
  const { can, isLoading } = usePermissions();
  const { enabled: moduleEnabled } = useModules();

  // Same optimistic-render pattern AppSidebar uses — while perms are
  // hydrating we show the full list rather than a flickering skeleton.
  const visible = isLoading
    ? PAGE_NAV
    : PAGE_NAV.filter(l => can(l.cap) && (!l.module || moduleEnabled(l.module)));

  if (visible.length === 0) return null;

  return (
    <div
      className="flex-1 overflow-y-auto p-3 space-y-0.5">
      {visible.map(item => {
        const Icon = item.icon;
        const hrefPath = item.href.split('?')[0];
        const active = item.matchPrefix
          ? !!pathname?.startsWith(hrefPath)
          : pathname === hrefPath;
        return (
          <Link
            key={item.href}
            href={item.href}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{
              color:      active ? 'var(--gc-blue)'        : 'var(--gc-text-1)',
              background: active ? 'var(--gc-blue-light)'  : 'transparent',
              fontWeight: active ? 600 : 500,
            }}
            onMouseEnter={e => {
              if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)';
            }}
            onMouseLeave={e => {
              if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}>
            <Icon size={16} style={{ color: active ? 'var(--gc-blue)' : 'var(--gc-text-2)' }} />
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

