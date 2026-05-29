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
  // `w-full h-full flex-1` is intentionally redundant — `w-full` handles
  // the block-parent case, `flex-1 min-w-0` handles the flex-parent
  // case. Some of the management page.tsx wrappers wrap us in a
  // `<div className="flex">`, which made the shell shrink to its
  // content width without flex-1; some don't, where w-full is what
  // expands us. Belt + braces so neither case can compress the body
  // back into the "ton of whitespace on the right" layout the user hit.
  return (
    <div
      className="flex flex-1 min-w-0 w-full h-full overflow-hidden"
      style={{ background: 'var(--gc-bg)' }}>
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
