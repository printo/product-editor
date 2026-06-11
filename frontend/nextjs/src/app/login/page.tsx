'use client';

import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import Script from 'next/script';
import { Lock, User, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { loginAction, googleLoginAction } from '@/app/actions/auth';

// Public OAuth client ID for printo.in's Google project — safe to expose to the
// browser (it is embedded in the page for any GIS integration). Override via
// NEXT_PUBLIC_GOOGLE_CLIENT_ID, which Next.js inlines at build time.
const GOOGLE_CLIENT_ID =
  process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ||
  '875434468582-2a7h0gahc6sq6jm3gfmre9cca1lhh0p7.apps.googleusercontent.com';

const LoginForm = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get('callbackUrl') || '/dashboard';

  const googleBtnRef = useRef<HTMLDivElement>(null);
  const [gsiReady, setGsiReady] = useState(false);

  const handleGoogleCredential = useCallback(async (response: { credential?: string }) => {
    if (!response.credential) {
      setError('Google sign-in was cancelled. Please try again.');
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      const result = await googleLoginAction(response.credential, callbackUrl);
      if (result?.error) {
        setError(result.error);
        setIsLoading(false);
        return;
      }
      // Full-page navigation so the dashboard loads with a fresh server session.
      window.location.href = result?.url || callbackUrl;
    } catch (err) {
      console.error('Google login action error:', err);
      setError('An error occurred during Google sign-in.');
      setIsLoading(false);
    }
  }, [callbackUrl]);

  useEffect(() => {
    const el = googleBtnRef.current;
    const gid = window.google?.accounts?.id;
    if (!gsiReady || !el || !gid) return;
    gid.initialize({
      client_id: GOOGLE_CLIENT_ID,
      callback: handleGoogleCredential,
      hd: 'printo.in', // account-chooser hint; domain is enforced server-side
      ux_mode: 'popup',
    });
    gid.renderButton(el, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'rectangular',
      logo_alignment: 'left',
      width: 320,
    });
  }, [gsiReady, handleGoogleCredential]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);
    formData.append('callbackUrl', callbackUrl);

    try {
      const result = await loginAction(formData);
      if (result?.error) {
        setError(result.error);
        setIsLoading(false);
        return;
      }
      // Full-page navigation so the dashboard loads with a fresh server session
      // (a soft client-side redirect leaves the SessionProvider logged-out and
      // the dashboard's layout fetch never fires until a manual refresh).
      window.location.href = result?.url || callbackUrl;
    } catch (err) {
      console.error('Login action error:', err);
      setError('An error occurred during login.');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Script
        src="https://accounts.google.com/gsi/client"
        strategy="afterInteractive"
        onReady={() => setGsiReady(true)}
      />
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-6 sm:p-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-indigo-100 mb-4">
            <Lock className="w-6 h-6 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">PIA Product Access</h1>
          <p className="mt-2 text-sm text-slate-600">
            Please sign in with your PIA credentials.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label htmlFor="username" className="block text-sm font-medium text-slate-700 mb-1">
              Username / Email
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type="text"
                id="username"
                required
                className="block w-full pl-10 pr-3 py-2 border border-slate-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 text-sm text-slate-900"
                placeholder="Enter your username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-slate-700 mb-1">
              Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-slate-400" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                id="password"
                required
                className="block w-full pl-10 pr-10 py-2 border border-slate-300 rounded-lg focus:ring-indigo-500 focus:border-indigo-500 text-sm text-slate-900"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-400 hover:text-slate-600 focus:outline-none"
              >
                {showPassword ? (
                  <EyeOff className="h-5 w-5" />
                ) : (
                  <Eye className="h-5 w-5" />
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-center p-3 text-sm text-rose-600 bg-rose-50 rounded-lg">
              <AlertCircle className="w-4 h-4 mr-2 flex-shrink-0" />
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex justify-center py-2.5 px-4 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isLoading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center" aria-hidden="true">
            <div className="w-full border-t border-slate-200" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-white px-3 text-xs font-medium uppercase tracking-wider text-slate-400">
              or
            </span>
          </div>
        </div>

        <div className="flex justify-center">
          <div
            ref={googleBtnRef}
            className={isLoading ? 'pointer-events-none opacity-60' : ''}
          />
        </div>
      </div>
    </div>
  );
};

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
