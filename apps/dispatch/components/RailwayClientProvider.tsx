/**
 * Wires Clerk's `getToken()` into the Railway API client. Mounted once
 * inside `<ClerkLoaded>` in the root layout. Mirrors the web app's
 * RailwayClientProvider — same purpose, same singleton pattern.
 *
 * Renders no UI; children are passed through unchanged.
 */
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@clerk/clerk-expo";
import { setRailwayTokenProvider } from "@/lib/railway";

export default function RailwayClientProvider({ children }: { children: ReactNode }) {
  const { getToken, isSignedIn } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      setRailwayTokenProvider(async () => null);
      return;
    }
    setRailwayTokenProvider(async () => {
      try { return (await getToken()) ?? null; }
      catch { return null; }
    });
  }, [getToken, isSignedIn]);

  return <>{children}</>;
}
