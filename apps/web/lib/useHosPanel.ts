/**
 * Cross-component handle on the HOS duty panel.
 *
 * The panel is mounted once by HosDutyButton in the top bar, but things
 * elsewhere need to open it focused on a particular driver — the driver
 * chip in a calendar column header, for one. A shared store beats
 * either mounting a second panel (two pollers, two sources of truth) or
 * threading a callback down through the calendar tree.
 */
import { create } from 'zustand';

interface HosPanelState {
  /** Driver to select when the panel opens. null = open on the default
   *  (first in the sorted rail). */
  requestedDriverId: number | null;
  /** Bumped on every request so the panel re-focuses even when the same
   *  driver is asked for twice in a row. */
  nonce: number;
  open: boolean;
  openFor: (driverId: number | null) => void;
  close: () => void;
}

export const useHosPanel = create<HosPanelState>((set) => ({
  requestedDriverId: null,
  nonce: 0,
  open: false,
  openFor: (driverId) => set((s) => ({
    requestedDriverId: driverId, open: true, nonce: s.nonce + 1,
  })),
  close: () => set({ open: false, requestedDriverId: null }),
}));
