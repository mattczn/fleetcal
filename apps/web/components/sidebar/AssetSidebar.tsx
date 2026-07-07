'use client';

import { useState, useRef, useEffect } from 'react';
import { Plus, Layers, Truck, Users, Container, Menu, Settings } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useSearchParams } from 'next/navigation';
import { useOrganization, useUser } from '@clerk/nextjs';
import { useCalendarStore, BatchItem } from '@/store/useCalendarStore';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';
import { isCrmUser, isInternalOrg } from '@/lib/internalOrg';
import { PRIMARY_NAV, type NavItem } from '@/components/nav/AppSidebar';
import DirectoryModal, { type DirectoryTab } from './DirectoryModal';
import MiniCalendar from './MiniCalendar';
import { ChevronRight, ChevronDown, Building2, MapPin, Headset } from 'lucide-react';

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
  const { can } = usePermissions();
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
          {/* Primary CTA — full FleetCal blue split button. Replaces the
              white-surface-with-blue-plus look. Both halves share the
              same blue body so the bookend stays visually unified; the
              hover state darkens just the hovered half via blue-hover. */}
          <div data-tour="new-load-area" className="flex rounded-2xl overflow-hidden text-sm font-medium"
            style={{ boxShadow: 'var(--shadow-1)', background: 'var(--gc-blue)' }}>
            <button
              onClick={() => openCreateModal()}
              className="flex items-center gap-2.5 pl-5 pr-4 py-3.5 flex-1 transition-colors"
              style={{ color: '#fff', background: 'var(--gc-blue)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-blue-hover)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--gc-blue)')}
            >
              <Plus size={22} style={{ color: '#fff' }} strokeWidth={2.4} />
              <span>New Load</span>
            </button>
            {/* Translucent white divider — keeps the split visible on
                blue without introducing a third color. */}
            <div style={{ width: 1, background: 'rgba(255,255,255,0.25)', alignSelf: 'stretch' }} />
            <button
              onClick={() => batchFileInputRef.current?.click()}
              className="flex items-center justify-center px-3.5 transition-colors"
              style={{ color: 'rgba(255,255,255,0.88)', background: 'var(--gc-blue)' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--gc-blue-hover)'; e.currentTarget.style.color = '#fff'; setBatchHovered(true); }}
              onMouseLeave={e => { e.currentTarget.style.background = 'var(--gc-blue)'; e.currentTarget.style.color = 'rgba(255,255,255,0.88)'; setBatchHovered(false); }}
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
              {can('drivers.view') && (
                <SubNavButton icon={Users}   label="Drivers"     onClick={() => openDirectory('drivers')} />
              )}
              <SubNavButton icon={Truck}     label="Trucks"      onClick={() => openDirectory('trucks')} />
              {trailersOn && (
                <SubNavButton icon={Container} label="Trailers"  onClick={() => openDirectory('trailers')} />
              )}
              {can('dispatchers.view') && (
                <SubNavButton icon={Headset} label="Dispatchers" onClick={() => openDirectory('dispatchers')} />
              )}
              {can('customers.view') && (
                <SubNavButton icon={Building2} label="Customers"  onClick={() => openDirectory('customers')} />
              )}
              <SubNavButton icon={MapPin}    label="Locations"   onClick={() => openDirectory('locations')} />
            </div>
          )}
          {can('loads.edit') && (
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
          )}
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

// The calendar rail's page nav reuses AppSidebar's PRIMARY_NAV directly
// (imported above) so the two nav surfaces can never drift apart — this
// list used to be a hand-maintained copy and kept falling out of sync
// (Command Center gate, CRM, Equipment children). Calendar itself is
// dropped since you're already on it. See PageNavSection below.

function PageNavSection() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can, isLoading } = usePermissions();
  const { enabled: moduleEnabled } = useModules();
  const { organization } = useOrganization();
  const { user } = useUser();
  // CRM (internalOnly) shows only for internal-org CRM users — same gate as
  // AppSidebar. isInternalOrg(undefined) is false during hydration → no flash.
  const internal = isInternalOrg(organization?.id) && isCrmUser(user?.id);

  const allowed = (it: NavItem): boolean =>
    (!it.internalOnly || internal) &&
    // Optimistic while perms hydrate (matches AppSidebar) — but internalOnly
    // still applies so CRM never flashes for non-internal users.
    (isLoading || (can(it.cap) && (!it.module || moduleEnabled(it.module))));

  // Drop Calendar (you're already on it — the brand header is the "here" cue).
  const items = PRIMARY_NAV.filter(it => it.href !== '/calendar' && allowed(it));

  // Collapsible groups (Equipment). Auto-open when you're actually on the
  // group's route; otherwise collapsed until you click the chevron — same as
  // AppSidebar, so it isn't stuck open on the calendar.
  const onEquipment = pathname?.startsWith('/equipment') ?? false;
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (onEquipment) setOpenGroups(prev => ({ ...prev, '/equipment': true }));
  }, [onEquipment]);

  if (items.length === 0) return null;
  const eqTab = searchParams?.get('tab') ?? 'maintenance';

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-0.5">
      {items.map(item => {
        if (item.kind === 'group') {
          const groupKey = item.href.split('?')[0]; // '/equipment'
          const onGroup = !!pathname?.startsWith(groupKey);
          const open = openGroups[groupKey] ?? onGroup;
          return (
            <div key={item.href} className="space-y-0.5">
              {/* Label navigates; the chevron (separate hit target) toggles. */}
              <div className="relative flex items-center">
                <RailLink href={item.href} label={item.label} Icon={item.icon} active={onGroup} className="flex-1" />
                <button
                  type="button"
                  aria-label={open ? 'Collapse Equipment' : 'Expand Equipment'}
                  onClick={() => setOpenGroups(prev => ({ ...prev, [groupKey]: !open }))}
                  className="absolute right-1 p-1.5 rounded-md transition-colors"
                  style={{ color: 'var(--gc-text-3)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              </div>
              {open && (
                <div className="pl-3 space-y-0.5">
                  {item.children.filter(allowed).map(child => (
                    <RailLink key={child.href} href={child.href} label={child.label} Icon={child.icon}
                      active={onGroup && eqTab === child.tab} />
                  ))}
                </div>
              )}
            </div>
          );
        }
        return (
          <RailLink key={item.href} href={item.href} label={item.label} Icon={item.icon}
            active={pathname === item.href.split('?')[0]} />
        );
      })}
    </div>
  );
}

function RailLink({ href, label, Icon, active, className }: {
  href: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  active: boolean;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${className ?? 'w-full'}`}
      style={{
        color:      active ? 'var(--gc-blue)'        : 'var(--gc-text-1)',
        background: active ? 'var(--gc-blue-light)'  : 'transparent',
        fontWeight: active ? 600 : 500,
      }}
      onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}>
      <Icon size={16} style={{ color: active ? 'var(--gc-blue)' : 'var(--gc-text-2)' }} />
      <span className="flex-1">{label}</span>
    </Link>
  );
}

