'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Calendar, BarChart2, Users, LayoutDashboard, FileCheck2, Receipt, Package, Gauge } from 'lucide-react';
import type { Capability, OrgModule } from '@fleetcal/types';
import { usePermissions } from '@/lib/usePermissions';
import { useModules } from '@/lib/useModules';

// Each nav link carries:
//   - cap     — the capability the user's role must have
//   - module  — (optional) the org-level module flag that must be ON
// Both must pass. Dashboard + Command Center are part of the core
// product (no module flag); the five SaaS-gated modules each name
// their flag so an org without that plan tier doesn't see the link.
const NAV_LINKS: Array<{
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  cap: Capability;
  module?: OrgModule;
}> = [
  { href: '/board',       label: 'Command Center', icon: LayoutDashboard, cap: 'loads.view' },
  { href: '/dashboard',   label: 'Dashboard',      icon: BarChart2,       cap: 'dashboard.access' },
  { href: '/closeout',    label: 'Closeout',       icon: FileCheck2,      cap: 'closeout.access',    module: 'closeout' },
  { href: '/accounting',  label: 'Accounting',     icon: Receipt,         cap: 'accounting.access',  module: 'accounting' },
  // Equipment subsumes the old Fuel + Maintenance nav links — one
  // page with three sub-tabs (Inspections / Maintenance / Fuel). The
  // /fuel and /maintenance routes still exist as redirects to
  // /equipment for stale bookmarks but they're no longer in the nav.
  // Gated on the maintenance module since any fleet using inspections
  // / maintenance has it on; fuel-only orgs are vanishingly rare in
  // practice.
  { href: '/equipment',   label: 'Equipment',      icon: Package,         cap: 'maintenance.access', module: 'maintenance' },
  // Drivers — performance scorecards. Read-only ops dashboarding;
  // driver CRUD still lives in Settings → Dispatchers/Drivers. No
  // module gate (any fleet that tracks loads + inspections benefits)
  // — the per-user `drivers.view` capability is the only filter.
  { href: '/drivers',     label: 'Drivers',        icon: Gauge,           cap: 'drivers.view' },
  { href: '/payroll',     label: 'Payroll',        icon: Users,           cap: 'payroll.access',     module: 'payroll' },
];

interface ManagementHeaderProps {
  title: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  onBack?: () => void;
  rightSlot?: React.ReactNode; // extra controls rendered between flex-1 and nav links
}

export default function ManagementHeader({ title, icon: Icon, onBack, rightSlot }: ManagementHeaderProps) {
  const pathname = usePathname();
  const { can, isLoading: permsLoading } = usePermissions();
  const { enabled: moduleEnabled } = useModules();

  // Filter the nav by BOTH axes: per-user capability AND per-org
  // module flag. While Clerk is still hydrating the membership, render
  // the full nav optimistically — flickering links would be worse than
  // briefly showing a link the API will 403 if clicked. As soon as
  // perms resolve, the restricted ones disappear.
  const visibleLinks = permsLoading
    ? NAV_LINKS
    : NAV_LINKS.filter(l => can(l.cap) && (!l.module || moduleEnabled(l.module)));

  return (
    <header
      className="shrink-0 flex items-center gap-3 px-4 select-none"
      style={{ background: '#1a73e8', height: 64, borderBottom: '1px solid #1558d6' }}
    >
      {/* Left: Calendar back button */}
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors"
          style={{ color: 'rgba(255,255,255,0.85)', border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.12)', cursor: 'pointer' }}
          onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Calendar size={14} />
          Calendar
        </button>
      ) : (
        <Link
          href="/calendar"
          className="flex items-center gap-2 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors"
          style={{ color: 'rgba(255,255,255,0.85)', border: '1px solid rgba(255,255,255,0.35)', background: 'rgba(255,255,255,0.12)' }}
          onMouseOver={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.22)'; }}
          onMouseOut={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.12)'; }}
        >
          <Calendar size={14} />
          Calendar
        </Link>
      )}

      {/* Page title */}
      <div className="flex items-center gap-2">
        <Icon size={19} style={{ color: 'rgba(255,255,255,0.8)' }} />
        <h1 className="text-xl font-normal" style={{ color: '#fff', letterSpacing: '-0.2px' }}>
          {title}
        </h1>
      </div>

      <div className="flex-1" />

      {rightSlot}

      {/* Right: nav links */}
      <nav className="flex items-center gap-1">
        {visibleLinks.map(({ href, label, icon: NavIcon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className="flex items-center gap-1.5 px-3 py-[7px] rounded-lg text-[13px] font-medium transition-colors"
              style={{
                color: active ? '#1a73e8' : 'rgba(255,255,255,0.9)',
                background: active ? '#fff' : 'transparent',
                border: `1px solid ${active ? '#fff' : 'rgba(255,255,255,0.35)'}`,
              }}
              onMouseOver={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.15)'; }}
              onMouseOut={e => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >
              <NavIcon size={14} />
              {label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
