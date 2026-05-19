import { useEffect, useState } from "react";
import NetInfo from "@react-native-community/netinfo";

/**
 * Returns the live online/offline state from NetInfo. `null` while the
 * first probe is in flight — components that branch on this should
 * treat null as "assume online" so the first render doesn't flash an
 * offline banner before NetInfo answers.
 *
 * "Online" here means: has network connection AND the device thinks
 * the internet is reachable. A captive-portal Wi-Fi will return
 * `isConnected: true` but `isInternetReachable: false`, and we want
 * to treat that as offline for our purposes.
 */
export function useOnline(): boolean | null {
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const reachable = state.isInternetReachable;
      // isInternetReachable can be null briefly during probing; fall back
      // to isConnected so the banner doesn't flicker on transient nulls.
      setOnline(reachable === null ? !!state.isConnected : !!reachable);
    });
    return unsubscribe;
  }, []);

  return online;
}
