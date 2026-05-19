import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import { fetchDriverByPhone, type DriverSession } from "@/lib/api/session";

export type DriverSessionState =
  | { status: "loading"; supabaseSession: null; driver: null }
  | { status: "signed-out"; supabaseSession: null; driver: null }
  | { status: "loading-driver"; supabaseSession: Session; driver: null }
  | { status: "matched"; supabaseSession: Session; driver: DriverSession }
  | { status: "not-found"; supabaseSession: Session; driver: null };

/**
 * Single source of truth for "who's logged in and what driver record do they map to".
 * Combines:
 *  - Supabase OTP session (the auth token)
 *  - Driver record lookup by the auth'd phone (the dispatch-side identity)
 */
export function useDriverSession(): DriverSessionState {
  const [supabaseSession, setSupabaseSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSupabaseSession(data.session);
      setAuthReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_e, s) => {
      setSupabaseSession(s);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const phone = supabaseSession?.user?.phone ?? null;
  const driverQuery = useQuery({
    queryKey: ["driver-by-phone", phone],
    queryFn:  () => fetchDriverByPhone(phone!),
    enabled:  !!phone,
    staleTime: 5 * 60 * 1000,
  });

  if (!authReady) {
    return { status: "loading", supabaseSession: null, driver: null };
  }
  if (!supabaseSession) {
    return { status: "signed-out", supabaseSession: null, driver: null };
  }
  // Distinguish "query hasn't resolved yet" (undefined) from "server
  // confirmed no matching driver" (null). The previous `!data` check
  // conflated them, which incorrectly bounced offline users — whose
  // query is paused, data === undefined — to the not-found screen.
  // Now we only land on not-found when the API has actually answered
  // with null. Paused / pending / pre-rehydrate states stay on the
  // loading splash so the persister has a chance to restore cached
  // driver record from a previous online launch.
  if (driverQuery.data === null) {
    return { status: "not-found", supabaseSession, driver: null };
  }
  if (!driverQuery.data) {
    return { status: "loading-driver", supabaseSession, driver: null };
  }
  return { status: "matched", supabaseSession, driver: driverQuery.data };
}
