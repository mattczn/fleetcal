'use client';

import { useAuth } from '@clerk/nextjs';
import { useEffect } from 'react';
import { setRailwayTokenProvider } from '@/lib/railway';

/**
 * Wires Clerk's `getToken` into the Railway client singleton. Render once
 * inside the ClerkProvider tree. Renders children unchanged.
 */
export function RailwayClientProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth();
  useEffect(() => {
    setRailwayTokenProvider(() => getToken());
  }, [getToken]);
  return <>{children}</>;
}
