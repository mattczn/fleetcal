'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Calendar, BarChart2, Users, LayoutDashboard, FileCheck2, Receipt } from 'lucide-react';

const NAV_LINKS = [
  { href: '/board',      label: 'Command Center', icon: LayoutDashboard },
  { href: '/dashboard',  label: 'Dashboard',      icon: BarChart2       },
  { href: '/closeout',   label: 'Closeout',       icon: FileCheck2      },
  { href: '/accounting', label: 'Accounting',     icon: Receipt         },
  { href: '/payroll',    label: 'Payroll',        icon: Users           },
];

interface ManagementHeaderProps {
  title: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  onBack?: () => void;
  rightSlot?: React.ReactNode; // extra controls rendered between flex-1 and nav links
}

export default function ManagementHeader({ title, icon: Icon, onBack, rightSlot }: ManagementHeaderProps) {
  const pathname = usePathname();

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
        {NAV_LINKS.map(({ href, label, icon: NavIcon }) => {
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
