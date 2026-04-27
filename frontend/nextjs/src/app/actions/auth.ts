'use server';

import { headers } from "next/headers";
import { signIn } from "@/pia-auth";
import { AuthError, CredentialsSignin } from "next-auth";
// next/navigation no longer exports isRedirectError in Next.js 16 —
// it moved to the internal redirect-error module.
import { isRedirectError } from "next/dist/client/components/redirect-error";

// Per-IP login rate limiter — fixed-window in-memory.
// Single-process limit; if frontend is scaled horizontally, replace with Redis.
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;
const attempts = new Map<string, { count: number; windowStart: number }>();

async function clientIp(): Promise<string> {
  const h = await headers();
  // Traefik / Cloudflare set X-Forwarded-For; first hop is the real client.
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return h.get("x-real-ip") || "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    attempts.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_ATTEMPTS) {
    return false;
  }
  entry.count += 1;
  return true;
}

// Opportunistic cleanup so the map doesn't grow unbounded under scan attacks.
function pruneRateLimit() {
  if (attempts.size < 1000) return;
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, entry] of attempts) {
    if (entry.windowStart < cutoff) attempts.delete(ip);
  }
}

export async function loginAction(formData: FormData) {
  const ip = await clientIp();
  pruneRateLimit();
  if (!checkRateLimit(ip)) {
    return { error: "Too many login attempts. Please wait a minute and try again." };
  }

  const username = formData.get("username") as string;
  const password = formData.get("password") as string;
  const callbackUrl = (formData.get("callbackUrl") as string) || "/dashboard";

  try {
    await signIn("credentials", {
      username,
      password,
      redirectTo: callbackUrl,
    });
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof CredentialsSignin) {
      switch (error.code) {
        case "PiaTimeout":
          return { error: "Login is taking too long. The auth service may be slow — please try again in a moment." };
        case "PiaServiceUnavailable":
          return { error: "The authentication service is temporarily unavailable. Please try again shortly." };
        default:
          return { error: "Invalid credentials. Please try again." };
      }
    }

    if (error instanceof AuthError) {
      return { error: "Something went wrong. Please try again." };
    }

    // For other errors, return a generic message
    return { error: "An unexpected error occurred. Please try again later." };
  }
}
