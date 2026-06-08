'use client';

import { useState, useRef } from 'react';
import { Plus, Layers, Truck, Users, Container, Menu, Settings, BarChart2, LayoutDashboard, FileCheck2, Receipt, Package, Gauge } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useCalendarStore, BatchItem } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import DirectoryModal, { type DirectoryTab } from './DirectoryModal';
import MiniCalendar from './MiniCalendar';
import type { Capability, OrgModule } from '@fleetcal/types';
import { ChevronRight, ChevronDown, Building2, MapPin } from 'lucide-react';

export default function AssetSidebar() {
  // The truck/asset list itself has moved to the right-hand TruckFleetPanel
  // (opened from the toolbar Truck icon). This sidebar still owns the
  // dispatcher's daily tools — New Load / Batch, MiniCalendar — plus the
  // cross-page nav rail that used to live in AppSidebar. The Manage
  // Assets / Manage Drivers / Settings buttons at the bottom remain
  // the doorway into the directory modals. (Category filter chips
  // moved into the truck tray alongside the truck list itself.)
  const { openCreateModal, sidebarOpen, toggleSidebar, startBatch, setBatchParseState, clearBatch, fieldSettings, promptInstructions, promptVariables, cardFontScale } = useCalendarStore();
  // Single unified directory entry point — collapses the old 3-button
  // "Manage trucks / drivers / trailers" group into one expandable
  // "Manage Assets" with 5 children (Drivers, Trucks, Trailers,
  // Customers, Locations). Each child opens the new DirectoryModal
  // pre-selected to its tab.
  const [manageOpen,   setManageOpen]   = useState(false);
  const [directoryTab, setDirectoryTab] = useState<DirectoryTab | null>(null);
  const [batchHovered, setBatchHovered] = useState(false);
  const { enabled: moduleEnabled } = useModules();
  const trailersOn = moduleEnabled('trailers');

  const openDirectory = (tab: DirectoryTab) => {
    setDirectoryTab(tab);
    setManageOpen(true); // keep the group expanded after open
  };
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
        className="ui-scale-scope flex flex-col h-full shrink-0 overflow-hidden"
        style={{
          background: 'var(--gc-surface)',
          width: sidebarOpen ? 256 : 0,
          borderRight: sidebarOpen ? '1px solid var(--gc-border)' : 'none',
          // Opt into the Settings → Appearance scale. The CSS overrides
          // in globals.css multiply text utilities by --ui-scale.
          ['--ui-scale' as keyof React.CSSProperties]: cardFontScale ?? 1,
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
          {/* FleetCal wordmark — replaces the older "org image +
              Dispatch" composition. App context (dispatch vs billing
              vs paperwork) is already conveyed by the URL + left-rail
              nav, so reserving the prime corner real estate for the
              brand mark is cleaner. */}
          <Image
            src="/logo-horizontal.png"
            alt="FleetCal"
            width={200}
            height={41}
            priority
            style={{ objectFit: 'contain', height: 41, width: 'auto' }}
          />
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

        {/* Category filter chips moved to TruckFleetPanel (toolbar
            Truck icon → right-side tray) so they sit next to the
            truck list they describe instead of competing with the
            cross-page nav rail for left-rail real estate. The
            calendar grid still reacts to the same store value
            (activeCategoryFilter) — only the control location moved. */}

        {/* Cross-page navigation — the dispatcher's jump list to every
            other surface in the app (Dashboard, Closeout, Equipment,
            etc.). The truck list that used to occupy this slot now
            lives in the right-hand TruckFleetPanel (toolbar Truck
            icon), so this rail is the calendar's primary nav surface
            and there's no separate AppSidebar mounted on /calendar.
            Cap + module gates mirror AppSidebar so a role without
            (e.g.) payroll.access doesn't see Payroll here either. */}
        <PageNavSection />

        {/* Manage Assets — expandable group with 5 children. Each
            child button opens the DirectoryModal pre-selected to
            the right tab. The header itself toggles expansion. */}
        <div className="shrink-0 p-3 space-y-0.5" style={{ borderTop: '1px solid var(--gc-border-light)' }}>
          <button
            onClick={() => setManageOpen(o => !o)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ color: 'var(--gc-text-1)' }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            {manageOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span className="flex-1 text-left">Manage Assets</span>
          </button>
          {manageOpen && (
            <div className="pl-3 space-y-0.5">
              <SubNavButton icon={Users}     label="Drivers"   onClick={() => openDirectory('drivers')} />
              <SubNavButton icon={Truck}     label="Trucks"    onClick={() => openDirectory('trucks')} />
              {trailersOn && (
                <SubNavButton icon={Container} label="Trailers" onClick={() => openDirectory('trailers')} />
              )}
              <SubNavButton icon={Building2} label="Customers" onClick={() => openDirectory('customers')} />
              <SubNavButton icon={MapPin}    label="Locations" onClick={() => openDirectory('locations')} />
            </div>
          )}
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

      {directoryTab && (
        <DirectoryModal
          initial={directoryTab}
          onClose={() => setDirectoryTab(null)}
        />
      )}
    </>
  );
}

// ── Sub-nav button helper ──────────────────────────────────────────────

function SubNavButton({ icon: Icon, label, onClick }: {
  icon: typeof Truck;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] transition-colors"
      style={{ color: 'var(--gc-blue)' }}
      onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-light)')}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      <Icon size={14} />
      {label}
    </button>
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
  { href: '/board',      label: 'Command Center', icon: LayoutDashboard, cap: 'loads.view',        module: 'dispatch_board' },
  // Display labels were "Closeout" / "Accounting" — renamed to
  // plain-language "Paperwork" / "Billing". URLs + capability
  // strings + module IDs stay unchanged so bookmarks, role configs,
  // and DB enum values keep working.
  { href: '/closeout',   label: 'Paperwork',      icon: FileCheck2,      cap: 'closeout.access',   module: 'closeout' },
  { href: '/accounting', label: 'Billing',        icon: Receipt,         cap: 'accounting.access', module: 'accounting' },
  { href: '/equipment?tab=maintenance', label: 'Equipment', icon: Package, cap: 'maintenance.access', module: 'maintenance', matchPrefix: true },
  { href: '/payroll',    label: 'Payroll',        icon: Users,           cap: 'payroll.access',    module: 'payroll' },
  { href: '/drivers',    label: 'Drivers',        icon: Gauge,           cap: 'drivers.view',      module: 'performance' },
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

