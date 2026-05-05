import { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * QueryClient configured for offline-first caching.
 *
 * - `staleTime` defaults to 5 minutes so we don't aggressively refetch on
 *   every screen transition. Individual queries can override.
 * - `gcTime` is 14 days — anything used in the last two weeks survives
 *   in the cache so the dispatcher can still review it offline.
 * - Network-mode "offlineFirst": React Query tries the network but
 *   serves cached data instantly. When offline, the cached data sticks
 *   without a refetch attempt that would error out.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      gcTime:    14 * 24 * 60 * 60_000,
      networkMode: "offlineFirst",
      retry: 1,
    },
    mutations: {
      // Mutations don't get the offline treatment — writes need a connection.
      networkMode: "online",
    },
  },
});

/**
 * AsyncStorage-backed persister. The persisted blob is purged after 14
 * days so we don't keep ancient data forever.
 */
export const persister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key:     "fleetcal.dispatch.queryCache.v1",
  throttleTime: 1_000, // batch writes to avoid thrashing AsyncStorage
});

export const PERSIST_MAX_AGE = 14 * 24 * 60 * 60_000;
