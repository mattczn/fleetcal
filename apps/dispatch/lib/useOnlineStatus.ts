/**
 * Returns the current device connectivity from NetInfo. `true` when the
 * device reports a connection (default while NetInfo is initializing),
 * `false` once it explicitly reports `isConnected === false`.
 *
 * Mirrors the gating used by OfflineBanner — keep them in sync.
 */
import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sub = NetInfo.addEventListener((s) => {
      setOnline(s.isConnected !== false);
    });
    return () => sub();
  }, []);
  return online;
}
