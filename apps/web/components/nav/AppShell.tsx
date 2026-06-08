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
 *
 * Global directory mount: AppShell owns one DirectoryModal instance
 * driven by GlobalDirectoryContext so the AppTopBar search results
 * (and any future quick-action) can open it without each page
 * re-mounting one. Calendar mounts its own via AssetSidebar.
 */

import { useCallback, useMemo, useState } from 'react';
import AppSidebar from './AppSidebar';
import AppTopBar from './AppTopBar';
import DirectoryModal from '@/components/sidebar/DirectoryModal';
import {
  GlobalDirectoryContext,
  type GlobalDirectoryContextValue,
  type GlobalDirectoryRequest,
} from '@/lib/useGlobalDirectory';

interface Props {
  title?: string;
  icon?: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  rightSlot?: React.ReactNode;
  /** Page body. The shell sets up flex / overflow so children just
   *  fill the remaining viewport — pages that need scroll should
   *  handle it inside. */
  children: React.ReactNode;
  /** Disable page-level vertical scroll. Use this on pages whose
   *  content is sized to fit the viewport and where any scrolling
   *  should happen INSIDE a child container (e.g. an OpsTable with
   *  fillHeight). Without this, main has overflow-y: auto and the
   *  whole page scrolls, defeating the child's internal scroll
   *  affordance. */
  noPageScroll?: boolean;
}

export default function AppShell({ title, icon, rightSlot, children, noPageScroll }: Props) {
  // Directory deep-link state — populated by openDirectory(); cleared
  // on close. We store the entire request so DirectoryModal gets
  // initial tab + the right initial*Id without us caring which kind.
  const [directoryReq, setDirectoryReq] = useState<GlobalDirectoryRequest | null>(null);

  const openDirectory = useCallback((req: GlobalDirectoryRequest) => {
    setDirectoryReq(req);
  }, []);
  const closeDirectory = useCallback(() => setDirectoryReq(null), []);

  const ctx = useMemo<GlobalDirectoryContextValue>(
    () => ({ openDirectory }),
    [openDirectory],
  );

  // `w-full h-full flex-1` is intentionally redundant — `w-full` handles
  // the block-parent case, `flex-1 min-w-0` handles the flex-parent
  // case. Some of the management page.tsx wrappers wrap us in a
  // `<div className="flex">`, which made the shell shrink to its
  // content width without flex-1; some don't, where w-full is what
  // expands us. Belt + braces so neither case can compress the body
  // back into the "ton of whitespace on the right" layout the user hit.
  return (
    <GlobalDirectoryContext.Provider value={ctx}>
      <div
        className="flex flex-1 min-w-0 w-full h-full overflow-hidden"
        style={{ background: 'var(--gc-bg)' }}>
        <AppSidebar />
        <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
          <AppTopBar title={title} icon={icon} rightSlot={rightSlot} />
          <main
            className={`flex-1 min-h-0 ${noPageScroll ? 'overflow-hidden flex flex-col' : 'overflow-y-auto'}`}
            style={{ background: 'var(--gc-bg)' }}>
            {children}
          </main>
        </div>
      </div>
      {directoryReq && (
        <DirectoryModal
          initial={directoryReq.tab}
          initialDriverId={directoryReq.initialDriverId}
          initialAssetId={directoryReq.initialAssetId}
          initialTrailerId={directoryReq.initialTrailerId}
          initialDispatcherId={directoryReq.initialDispatcherId}
          initialBrokerId={directoryReq.initialBrokerId}
          initialLocationId={directoryReq.initialLocationId}
          onClose={closeDirectory}
        />
      )}
    </GlobalDirectoryContext.Provider>
  );
}
