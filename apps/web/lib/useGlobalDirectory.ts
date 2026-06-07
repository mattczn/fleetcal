'use client';

/**
 * useGlobalDirectory — context + hook for opening the shared
 * DirectoryModal from anywhere under AppShell. The shell owns the
 * actual modal mount; descendants (the global search dropdown,
 * eventual quick-action keyboard shortcuts) just call openDirectory()
 * with a tab + optional deep-link id.
 */

import { createContext, useContext } from 'react';
import type { DirectoryTab } from '@/components/sidebar/DirectoryModal';

export interface GlobalDirectoryRequest {
  tab: DirectoryTab;
  /** Only the id matching the chosen tab is consulted by DirectoryModal. */
  initialDriverId?:   number;
  initialAssetId?:    number;
  initialTrailerId?:  number;
  initialBrokerId?:   string;
  initialLocationId?: string;
}

export interface GlobalDirectoryContextValue {
  openDirectory: (req: GlobalDirectoryRequest) => void;
}

/** Null when consumed outside AppShell — calendar surface and any
 *  unwrapped page. Consumers should guard. */
export const GlobalDirectoryContext = createContext<GlobalDirectoryContextValue | null>(null);

export function useGlobalDirectory(): GlobalDirectoryContextValue | null {
  return useContext(GlobalDirectoryContext);
}
