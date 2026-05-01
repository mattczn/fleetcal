/**
 * Driver-mobile type re-exports.
 *
 * Domain types now live in @fleetcal/types. This file is a thin re-export
 * so existing `from './types'` callers don't have to change.
 */

export type {
  Load,
  LoadStatus,
  StopType,
  Stop,
  RefNum,
  Trailer,
  TrailerCategory,
} from "@fleetcal/types";
