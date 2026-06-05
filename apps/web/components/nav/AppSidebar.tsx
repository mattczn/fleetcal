'use client';

/**
 * AppSidebar — left-rail navigation for every page EXCEPT /calendar.
 *
 * Calendar keeps its existing top toolbar (it's a dense single-screen
 * surface where horizontal real estate is precious + its toolbar
 * carries view-specific controls that don't fit in a generic shell).
 * Everything else (Dashboard, Command Center, Closeout, Accounting,
 * Equipment, Payroll, Drivers, Settings) gets this rail.
 *
 * Behavior:
 *   - 240px expanded (default), 60px collapsed (icons only). State
 *     persists per-browser via localStorage so the user's preference
 *     survives page navigations + reloads.
 *   - Equipment is a parent with three sub-items (Maintenance,
 *     Inspections, Fuel). When expanded, sub-items render indented
 *     below the parent. When collapsed (icon-only), sub-items hide;
 *     hovering the Equipment icon reveals them in a flyout (TODO —
 *     for v1 they just stay hidden in collapsed mode; clicking
 *     Equipment still lands on the default sub-tab).
 *   - Active item is highlighted with a 3px blue strip on the left
 *     plus a subtle tinted background. The active state is computed
 *     from pathname + (?tab=) search param so the right Equipment
 *     sub-item highlights based on the URL.
 *   - Cap + module gating mirrors the old ManagementHeader logic —
 *     a user without the relevant capability sees the item hidden,
 *     and during Clerk hydration we render the full nav optimistically
 *     (flickering links would be worse than a brief restricted view).
 */

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Calendar, BarChart2, LayoutDashboard, FileCheck2, Receipt, Package,
  Gauge, Users, Settings, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight,
  Wrench, ClipboardCheck, Fuel as FuelIcon,
} from 'lucide-react';
import type { Capability, OrgModule } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';

interface NavLeaf {
  kind:   'leaf';
  href:   string;
  /** Optional ?tab= match for sub-items on a shared route (Equipment). */
  tab?:   string;
  label:  string;
  icon:   React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  cap:    Capability;
  module?: OrgModule;
}
interface NavGroup {
  kind:    'group';
  href:    string;     // landing route (clicking the parent still goes here)
  label:   string;
  icon:    React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  cap:     Capability;
  module?: OrgModule;
  children: NavLeaf[];
}
type NavItem = NavLeaf | NavGroup;

/** Primary nav — order matters: most-used first (Calendar pins to the
 *  top because users jump back here constantly). Bottom-most items are
 *  rendered in the "secondary" section (Settings). */
const PRIMARY_NAV: NavItem[] = [
  { kind: 'leaf', href: '/calendar',    label: 'Calendar',       icon: Calendar,        cap: 'loads.view' },
  { kind: 'leaf', href: '/dashboard',   label: 'Dashboard',      icon: BarChart2,       cap: 'dashboard.access' },
  { kind: 'leaf', href: '/board',       label: 'Command Center', icon: LayoutDashboard, cap: 'loads.view',        module: 'dispatch_board' },
  { kind: 'leaf', href: '/closeout',    label: 'Closeout',       icon: FileCheck2,      cap: 'closeout.access',   module: 'closeout' },
  { kind: 'leaf', href: '/accounting',  label: 'Accounting',     icon: Receipt,         cap: 'accounting.access', module: 'accounting' },
  {
    kind: 'group',
    href: '/equipment?tab=maintenance',
    label: 'Equipment',
    icon: Package,
    cap: 'maintenance.access',
    module: 'maintenance',
    children: [
      { kind: 'leaf', href: '/equipment?tab=maintenance', tab: 'maintenance', label: 'Maintenance', icon: Wrench,          cap: 'maintenance.access', module: 'maintenance' },
      { kind: 'leaf', href: '/equipment?tab=inspections', tab: 'inspections', label: 'Inspections', icon: ClipboardCheck,  cap: 'maintenance.access', module: 'maintenance' },
      { kind: 'leaf', href: '/equipment?tab=fuel',        tab: 'fuel',        label: 'Fuel',        icon: FuelIcon,        cap: 'maintenance.access', module: 'maintenance' },
    ],
  },
  { kind: 'leaf', href: '/payroll',     label: 'Payroll',        icon: Users,           cap: 'payroll.access',    module: 'payroll' },
  { kind: 'leaf', href: '/drivers',     label: 'Drivers',        icon: Gauge,           cap: 'drivers.view',      module: 'performance' },
];

const SECONDARY_NAV: NavItem[] = [
  { kind: 'leaf', href: '/settings',    label: 'Settings',       icon: Settings,        cap: 'loads.view' },
];

const STORAGE_KEY = 'app-sidebar-collapsed';
const SIDEBAR_W_EXPANDED = 240;
const SIDEBAR_W_COLLAPSED = 60;

export default function AppSidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { can, isLoading: permsLoading } = usePermissions();
  const { enabled: moduleEnabled } = useModules();

  // Collapse state — defaults to expanded; hydrates from localStorage
  // on mount so SSR doesn't mismatch. We render expanded on first paint
  // and flip post-hydrate if the user had collapsed it previously;
  // imperceptible in practice.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === '1') setCollapsed(true);
    } catch { /* ignore */ }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed(c => {
      const next = !c;
      try { window.localStorage.setItem(STORAGE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  // Equipment auto-expands when the user is on /equipment. Otherwise
  // honors a local open/closed state so they can manually pop it open
  // even when not on the equipment page (to jump to a sub-tab fast).
  const onEquipment = pathname?.startsWith('/equipment') ?? false;
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (onEquipment) setGroupOpen(prev => ({ ...prev, Equipment: true }));
  }, [onEquipment]);

  const filterVisible = (items: NavItem[]): NavItem[] =>
    permsLoading
      ? items
      : items.filter(it => can(it.cap) && (!it.module || moduleEnabled(it.module)));

  const primary   = filterVisible(PRIMARY_NAV);
  const secondary = filterVisible(SECONDARY_NAV);

  /** Is a given leaf "active" right now? Match by pathname; for sub-tab
   *  leaves, also require the ?tab= match. */
  const isActive = (leaf: NavLeaf): boolean => {
    const hrefPath = leaf.href.split('?')[0];
    if (pathname !== hrefPath) return false;
    if (leaf.tab) {
      const currentTab = searchParams?.get('tab');
      return currentTab === leaf.tab;
    }
    return true;
  };

  return (
    <aside
      className="shrink-0 flex flex-col select-none"
      style={{
        width: collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W_EXPANDED,
        background: 'var(--gc-surface)',
        borderRight: '1px solid var(--gc-border-light)',
        transition: 'width 180ms ease',
        height: '100vh',
        position: 'sticky',
        top: 0,
        zIndex: 30,
      }}>

      {/* Brand strip — minimal. Just the app name. */}
      <div
        className="flex items-center px-3"
        style={{
          height: 56,
          borderBottom: '1px solid var(--gc-border-light)',
          gap: 10,
        }}>
        <div
          className="rounded-md flex items-center justify-center shrink-0"
          style={{
            width: 32, height: 32,
            background: 'var(--gc-blue)',
            color: '#fff',
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: '-0.5px',
          }}>
          F
        </div>
        {!collapsed && (
          <div
            className="text-[15px] font-bold truncate"
            style={{ color: 'var(--gc-text-1)', letterSpacing: '-0.2px' }}>
            FleetCal
          </div>
        )}
      </div>

      {/* Primary nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 flex flex-col gap-0.5 px-2">
        {primary.map(item =>
          item.kind === 'leaf'
            ? <LeafLink key={item.href} item={item} active={isActive(item)} collapsed={collapsed} />
            : <Group
                key={item.label}
                item={item}
                open={!!groupOpen[item.label]}
                onToggleOpen={() => setGroupOpen(g => ({ ...g, [item.label]: !g[item.label] }))}
                collapsed={collapsed}
                isActive={isActive}
                pathname={pathname}
              />
        )}

        {secondary.length > 0 && (
          <>
            <div style={{ height: 8 }} />
            <div
              style={{
                borderTop: '1px solid var(--gc-border-light)',
                margin: '0 8px 8px',
              }}
            />
            {secondary.map(item =>
              item.kind === 'leaf'
                ? <LeafLink key={item.href} item={item} active={isActive(item)} collapsed={collapsed} />
                : null
            )}
          </>
        )}
      </nav>

      {/* Collapse toggle — pinned to the bottom */}
      <div
        className="px-2 py-2"
        style={{ borderTop: '1px solid var(--gc-border-light)' }}>
        <button
          type="button"
          onClick={toggleCollapsed}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex items-center gap-2 rounded-md w-full transition-colors"
          style={{
            color: 'var(--gc-text-3)',
            background: 'transparent',
            padding: '8px',
            fontSize: 12,
            fontWeight: 500,
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'var(--gc-hover)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {collapsed
            ? <ChevronsRight size={15} />
            : <><ChevronsLeft size={15} /><span>Collapse</span></>
          }
        </button>
      </div>
    </aside>
  );
}

// ── Leaf link ─────────────────────────────────────────────────────────

function LeafLink({
  item, active, collapsed, indent = 0,
}: {
  item: NavLeaf;
  active: boolean;
  collapsed: boolean;
  indent?: number;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      className="group flex items-center rounded-md transition-colors"
      style={{
        textDecoration: 'none',
        color: active ? 'var(--gc-blue)' : 'var(--gc-text-1)',
        background: active ? 'var(--gc-blue-light)' : 'transparent',
        padding: collapsed ? '9px 0' : `9px 12px 9px ${12 + indent}px`,
        justifyContent: collapsed ? 'center' : 'flex-start',
        fontSize: 13.5,
        fontWeight: active ? 600 : 500,
        position: 'relative',
        gap: collapsed ? 0 : 10,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      {active && !collapsed && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 0,
            top: 6,
            bottom: 6,
            width: 3,
            background: 'var(--gc-blue)',
            borderTopRightRadius: 2,
            borderBottomRightRadius: 2,
          }}
        />
      )}
      <Icon size={16} style={{ color: active ? 'var(--gc-blue)' : 'var(--gc-text-2)', flexShrink: 0 }} />
      {!collapsed && <span className="truncate">{item.label}</span>}
    </Link>
  );
}

// ── Group (parent with sub-items) ─────────────────────────────────────

function Group({
  item, open, onToggleOpen, collapsed, isActive, pathname,
}: {
  item: NavGroup;
  open: boolean;
  onToggleOpen: () => void;
  collapsed: boolean;
  isActive: (leaf: NavLeaf) => boolean;
  pathname: string | null;
}) {
  const Icon = item.icon;
  // Parent-active = any direct child is active.
  const anyChildActive = item.children.some(isActive);
  // When collapsed, render the parent as a leaf (clicking goes to the
  // default landing route); sub-items don't render so we don't need a
  // flyout. Hover-flyout could be a v2 polish.
  if (collapsed) {
    return (
      <Link
        href={item.href}
        title={item.label}
        className="group flex items-center justify-center rounded-md transition-colors"
        style={{
          textDecoration: 'none',
          color: anyChildActive ? 'var(--gc-blue)' : 'var(--gc-text-1)',
          background: anyChildActive ? 'var(--gc-blue-light)' : 'transparent',
          padding: '9px 0',
          fontSize: 13.5,
          fontWeight: anyChildActive ? 600 : 500,
        }}
        onMouseEnter={e => { if (!anyChildActive) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { if (!anyChildActive) e.currentTarget.style.background = 'transparent'; }}>
        <Icon size={16} style={{ color: anyChildActive ? 'var(--gc-blue)' : 'var(--gc-text-2)' }} />
      </Link>
    );
  }
  // Expanded: parent row has a chevron toggle on the right; clicking
  // the row LABEL/icon navigates, clicking the chevron toggles
  // open/closed (chevron is a separate hit target via stopPropagation).
  return (
    <div className="flex flex-col">
      <div
        className="flex items-center rounded-md transition-colors"
        style={{
          color: anyChildActive ? 'var(--gc-blue)' : 'var(--gc-text-1)',
          background: anyChildActive ? 'var(--gc-blue-light)' : 'transparent',
          fontSize: 13.5,
          fontWeight: anyChildActive ? 600 : 500,
          position: 'relative',
        }}
        onMouseEnter={e => { if (!anyChildActive) e.currentTarget.style.background = 'var(--gc-hover)'; }}
        onMouseLeave={e => { if (!anyChildActive) e.currentTarget.style.background = 'transparent'; }}>
        {anyChildActive && (
          <span
            aria-hidden
            style={{
              position: 'absolute',
              left: 0,
              top: 6,
              bottom: 6,
              width: 3,
              background: 'var(--gc-blue)',
              borderTopRightRadius: 2,
              borderBottomRightRadius: 2,
            }}
          />
        )}
        <Link
          href={item.href}
          className="flex items-center gap-2.5 flex-1 min-w-0"
          style={{
            textDecoration: 'none',
            color: 'inherit',
            padding: '9px 4px 9px 12px',
          }}>
          <Icon size={16} style={{ color: anyChildActive ? 'var(--gc-blue)' : 'var(--gc-text-2)', flexShrink: 0 }} />
          <span className="truncate">{item.label}</span>
        </Link>
        <button
          type="button"
          aria-label={open ? `Collapse ${item.label}` : `Expand ${item.label}`}
          onClick={onToggleOpen}
          className="flex items-center justify-center rounded transition-colors"
          style={{
            height: 28, width: 28,
            margin: '0 8px 0 0',
            color: 'var(--gc-text-3)',
            background: 'transparent',
            cursor: 'pointer',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.04)')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      </div>
      {open && (
        <div className="flex flex-col gap-0.5 mt-0.5">
          {item.children
            .filter(c => true) // cap filtering already happened at filterVisible
            .map(c => (
              <SubLeafLink
                key={c.href}
                item={c}
                active={isActive(c)}
                pathname={pathname}
              />
            ))}
        </div>
      )}
    </div>
  );
}

function SubLeafLink({
  item, active,
}: {
  item: NavLeaf;
  active: boolean;
  pathname: string | null;
}) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className="group flex items-center rounded-md transition-colors"
      style={{
        textDecoration: 'none',
        color: active ? 'var(--gc-blue)' : 'var(--gc-text-2)',
        background: active ? 'var(--gc-blue-light)' : 'transparent',
        padding: '7px 12px 7px 38px',
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        gap: 8,
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--gc-hover)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}>
      <Icon size={13} style={{ color: active ? 'var(--gc-blue)' : 'var(--gc-text-3)', flexShrink: 0 }} />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
