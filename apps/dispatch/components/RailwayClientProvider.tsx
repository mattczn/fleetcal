/**
 * Wires Clerk's `getToken()` into the Railway API client. Mounted once
 * inside `<ClerkLoaded>` in the root layout. Mirrors the web app's
 * RailwayClientProvider — same purpose, same singleton pattern.
 *
 * The provider is updated synchronously during render (rather than in
 * useEffect) so it's wired BEFORE any descendant effect can fire — which
 * matters because child effects run before parent effects, and our
 * CachePrefetcher would otherwise hit the API unauthenticated on its
 * first mount.
 */
import { type ReactNode } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { setRailwayTokenProvider } from "@/lib/railway";

export default function RailwayClientProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  // Set the singleton token provider on every render. It's idempotent
  // (just stores a function ref) so the cost is negligible.
  if (isSignedIn) {
    setRailwayTokenProvider(async () => {
      try { return (await getToken()) ?? null; }
      catch { return null; }
    });
  } else {
    setRailwayTokenProvider(async () => null);
  }

  return <>{children}</>;
}
