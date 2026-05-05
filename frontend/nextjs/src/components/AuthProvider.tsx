'use client';

import { SessionProvider } from "next-auth/react";
import type { Session } from "next-auth";

interface AuthProviderProps {
  children: React.ReactNode;
  // Pre-hydration session from the server. When provided, useSession()
  // returns this immediately on first render — no flash of "User" /
  // "0 templates" while the client fetches /api/auth/session post-mount.
  session?: Session | null;
}

export const AuthProvider = ({ children, session }: AuthProviderProps) => {
  return <SessionProvider session={session}>{children}</SessionProvider>;
};
