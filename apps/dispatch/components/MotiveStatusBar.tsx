import React from "react";
import { View, Text, TouchableOpacity, ActivityIndicator } from "react-native";
import { RefreshCw, Truck, TruckIcon, AlertCircle, WifiOff } from "lucide-react-native";
import type { MotiveLocation } from "@/lib/motive";
import { txt } from "@/lib/font";

interface Props {
  /** Asset has a motive_vehicle_id linked. False → asset isn't in Motive, refresh won't help. */
  hasVehicleId: boolean;
  /** The resolved location pin for this asset, if any. Null = not present in the latest response. */
  truckLoc:     MotiveLocation | null | undefined;
  /** dataUpdatedAt from the React Query (ms since epoch). 0 / undefined → never fetched. */
  lastUpdateMs: number | undefined;
  /** isFetching from the React Query. */
  isFetching:   boolean;
  /** Manual refresh handler — invalidates / refetches the motive-locations query. */
  onRefresh:    () => void;
}

function fmtAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 30_000) return "just now";
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/**
 * Small chip rendered above the route map. Shows the current Motive state
 * for this load's asset and gives the dispatcher a manual refresh button —
 * the underlying query has a 5-minute staleTime, so locations can fall
 * behind a fast-moving truck. The chip distinguishes four states:
 *
 *   1. No motive vehicle linked → grey, no refresh button. Refresh won't
 *      help; the asset needs a vehicle id in Settings.
 *   2. Linked but no pin returned → amber, refresh button. The vehicle
 *      isn't in the latest /api/motive/locations response (engine off,
 *      out of cellular, fleet permission, etc.). Refresh worth trying.
 *   3. Linked + pin found → green, shows "updated Xm ago" + refresh.
 *   4. Fetch never succeeded (lastUpdate == 0) → red, "Motive unavailable"
 *      + refresh. Probably an API key / Clerk-token / network issue.
 */
export function MotiveStatusBar({ hasVehicleId, truckLoc, lastUpdateMs, isFetching, onRefresh }: Props) {
  // State 1: no vehicle linked on the asset.
  if (!hasVehicleId) {
    return (
      <View style={styles.bar(palette.grey)}>
        <Truck size={14} color={palette.grey.fg} strokeWidth={2.2} />
        <Text style={[txt(700), { fontSize: 12, color: palette.grey.fg, flex: 1 }]}>
          Asset not linked to Motive
        </Text>
      </View>
    );
  }

  // State 4: never had a successful fetch (lastUpdateMs is 0 / undefined).
  if (!lastUpdateMs) {
    return (
      <View style={styles.bar(palette.red)}>
        <WifiOff size={14} color={palette.red.fg} strokeWidth={2.4} />
        <Text style={[txt(700), { fontSize: 12, color: palette.red.fg, flex: 1 }]}>
          Motive unavailable
        </Text>
        <RefreshButton onPress={onRefresh} fetching={isFetching} tint={palette.red.fg} />
      </View>
    );
  }

  // State 2: linked, fetched, but no pin returned for this vehicle.
  if (!truckLoc) {
    return (
      <View style={styles.bar(palette.amber)}>
        <AlertCircle size={14} color={palette.amber.fg} strokeWidth={2.4} />
        <Text style={[txt(700), { fontSize: 12, color: palette.amber.fg, flex: 1 }]}>
          Truck not reporting · checked {fmtAgo(lastUpdateMs)}
        </Text>
        <RefreshButton onPress={onRefresh} fetching={isFetching} tint={palette.amber.fg} />
      </View>
    );
  }

  // State 3: linked + located.
  return (
    <View style={styles.bar(palette.green)}>
      <TruckIcon size={14} color={palette.green.fg} strokeWidth={2.4} />
      <Text style={[txt(700), { fontSize: 12, color: palette.green.fg, flex: 1 }]}>
        Truck updated {fmtAgo(new Date(truckLoc.locatedAt).getTime())}
      </Text>
      <RefreshButton onPress={onRefresh} fetching={isFetching} tint={palette.green.fg} />
    </View>
  );
}

function RefreshButton({ onPress, fetching, tint }: { onPress: () => void; fetching: boolean; tint: string }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={fetching}
      hitSlop={10}
      style={{
        width: 26, height: 26, borderRadius: 13,
        alignItems: "center", justifyContent: "center",
        backgroundColor: "rgba(255,255,255,0.45)",
        opacity: fetching ? 0.5 : 1,
      }}
    >
      {fetching
        ? <ActivityIndicator size="small" color={tint} />
        : <RefreshCw size={13} color={tint} strokeWidth={2.6} />}
    </TouchableOpacity>
  );
}

type Tint = { bg: string; border: string; fg: string };

const palette = {
  green: { bg: "#dcfce7", border: "#86efac", fg: "#166534" } as Tint,
  amber: { bg: "#fef9c3", border: "#fde68a", fg: "#854d0e" } as Tint,
  red:   { bg: "#fee2e2", border: "#fca5a5", fg: "#991b1b" } as Tint,
  grey:  { bg: "#f1f3f4", border: "#e8eaed", fg: "#5f6368" } as Tint,
};

const styles = {
  bar: (t: Tint) => ({
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: t.bg,
    borderWidth: 1,
    borderColor: t.border,
    marginBottom: 10,
  }),
};
