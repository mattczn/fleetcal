import { useEffect, useMemo, useState, useCallback } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Asset } from "./types";

interface AssetPrefs {
  hidden: number[];   // asset IDs the dispatcher wants hidden in the pager
  order:  number[];   // asset IDs in display order; missing IDs append in their default sortOrder
}

const DEFAULTS: AssetPrefs = { hidden: [], order: [] };

function storageKey(orgId: string | undefined): string {
  return `dispatchgo:assetPrefs:${orgId ?? "default"}`;
}

/**
 * Per-device asset visibility + ordering for the calendar pager.
 * Persisted in AsyncStorage scoped by orgId.
 *
 * `visibleAssets` is what to render in the swipe-pager (in selected order,
 * default-sorted assets appended last, and hidden ones removed).
 * `allAssets` is unfiltered/unordered (use for the side panel UI).
 */
export function useAssetPrefs(orgId: string | undefined, allAssets: Asset[]) {
  const [prefs, setPrefs] = useState<AssetPrefs>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  // Hydrate from disk
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    AsyncStorage.getItem(storageKey(orgId))
      .then((raw) => {
        if (cancelled) return;
        if (raw) {
          try { setPrefs({ ...DEFAULTS, ...JSON.parse(raw) }); }
          catch { setPrefs(DEFAULTS); }
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, [orgId]);

  const persist = useCallback((next: AssetPrefs) => {
    setPrefs(next);
    if (orgId) AsyncStorage.setItem(storageKey(orgId), JSON.stringify(next)).catch(() => { /* ignore */ });
  }, [orgId]);

  const setHidden = useCallback((id: number, hidden: boolean) => {
    persist({
      ...prefs,
      hidden: hidden
        ? Array.from(new Set([...prefs.hidden, id]))
        : prefs.hidden.filter((x) => x !== id),
    });
  }, [prefs, persist]);

  const setAllHidden = useCallback((hidden: boolean) => {
    persist({
      ...prefs,
      hidden: hidden ? allAssets.map((a) => a.id) : [],
    });
  }, [prefs, persist, allAssets]);

  const move = useCallback((id: number, direction: "up" | "down") => {
    // Build the current effective order (including default-sorted unset items),
    // then move the id one step.
    const ordered = effectiveOrder(prefs.order, allAssets);
    const idx = ordered.indexOf(id);
    if (idx === -1) return;
    const next = [...ordered];
    const swap = direction === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    persist({ ...prefs, order: next });
  }, [prefs, persist, allAssets]);

  const orderedIds = useMemo(
    () => effectiveOrder(prefs.order, allAssets),
    [prefs.order, allAssets],
  );

  const visibleAssets = useMemo(() => {
    if (!loaded || allAssets.length === 0) return [] as Asset[];
    const byId = new Map(allAssets.map((a) => [a.id, a]));
    return orderedIds
      .map((id) => byId.get(id))
      .filter((a): a is Asset => !!a)
      .filter((a) => !a.hidden && !prefs.hidden.includes(a.id));
  }, [allAssets, prefs, orderedIds, loaded]);

  return { prefs, visibleAssets, orderedIds, setHidden, setAllHidden, move, loaded };
}

function effectiveOrder(savedOrder: number[], allAssets: Asset[]): number[] {
  const seen = new Set(savedOrder);
  // Keep only IDs that still exist in allAssets
  const head = savedOrder.filter((id) => allAssets.some((a) => a.id === id));
  // Append any new assets in their default sort order
  const tail = [...allAssets]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((a) => !seen.has(a.id))
    .map((a) => a.id);
  return [...head, ...tail];
}
