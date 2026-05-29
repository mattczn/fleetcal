'use client';

/**
 * AppShell — page-level layout for every non-calendar surface.
 *
 * Composes AppSidebar (left rail) + AppTopBar (slim header) + page
 * body. Replaces ManagementHeader as the standard wrapper for
 * Drivers, Equipment, Closeout, Accounting, Payroll, Dashboard,
 * Command Center, Settings.
 *
 * Layout:
 *
 *   ┌─────────┬───────────────────────────────────────────┐
 *   │  Side   │  AppTopBar (56px)                          │
 *   │  bar    ├───────────────────────────────────────────┤
 *   │ (240px) │                                            │
 *   │         │  {children}                                │
 *   │         │                                            │
 *   └─────────┴───────────────────────────────────────────┘
 *
 * Calendar keeps its own layout — see /calendar/page.tsx. The shell
 * is opt-in: pages that want it wrap their content with <AppShell>,
 * pages that don't (like calendar) just don't.
 */

import AppSidebar from './AppSidebar';
import AppTopBar from './AppTopBar';

interface Props {
  title?: string;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  rightSlot?: React.ReactNode;
  /** Page body. The shell sets up flex / overflow so children just
   *  fill the remaining viewport — pages that need scroll should
   *  handle it inside. */
  children: React.ReactNode;
}

export default function AppShell({ title, icon, rightSlot, children }: Props) {
  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--gc-bg)' }}>
      <AppSidebar />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <AppTopBar title={title} icon={icon} rightSlot={rightSlot} />
        <main className="flex-1 min-h-0 overflow-y-auto" style={{ background: 'var(--gc-bg)' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
