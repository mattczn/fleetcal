import { QueryClient } from "@tanstack/react-query";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";

/**
 * App-wide QueryClient + AsyncStorage persister. Lives in its own module
 * so the persister can be referenced from PersistQueryClientProvider in
 * _layout.tsx and the client can be reached from anywhere (push-token
 * registration, prefetch helpers, etc.) without prop drilling.
 *
 *   gcTime: 24h — keep entries around long enough that a driver who
 *     opens the app in a dead zone the next morning still sees yesterday's
 *     loads. Anything older than this gets evicted from memory.
 *
 *   staleTime: 30s — same as before; queries refetch on focus / mount
 *     after half a minute. Only matters while online.
 *
 *   networkMode (queries): "online" — when offline, queries are paused
 *     and any previously-cached data keeps rendering. Calling refetch()
 *     (e.g. pull-to-refresh) while offline is a no-op rather than an
 *     error, so the cached loads don't disappear behind an error state.
 *
 *   networkMode (mutations): "offlineFirst" — mutations are queued
 *     while offline and auto-replay when the radio comes back, so a
 *     check-in or status change made in a dead zone isn't lost.
 */
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: TWENTY_FOUR_HOURS,
      staleTime: 30_000,
      retry: 2,
      networkMode: "online",
    },
    mutations: {
      retry: 3,
      networkMode: "offlineFirst",
    },
  },
});

export const asyncStoragePersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  key: "fleetcal-driver-cache-v1",
  throttleTime: 1_000,
});

export const PERSIST_MAX_AGE = TWENTY_FOUR_HOURS;
