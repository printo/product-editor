'use server';

import { signIn } from "@/pia-auth";
import { AuthError } from "next-auth";
// next/navigation no longer exports isRedirectError in Next.js 16 —
// it moved to the internal redirect-error module.
import { isRedirectError } from "next/dist/client/components/redirect-error";

export async function loginAction(formData: FormData) {
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
    
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return { error: "Invalid credentials. Please try again." };
        default:
          return { error: "Something went wrong. Please try again." };
      }
    }
    
    // For other errors, return a generic message
    return { error: "An unexpected error occurred. Please try again later." };
  }
}
