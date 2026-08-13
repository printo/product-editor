'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';

const REDIRECT_SECONDS = 3;

export default function DjangoAdminDeniedPage() {
  const [secondsLeft, setSecondsLeft] = useState(REDIRECT_SECONDS);
  const router = useRouter();

  useEffect(() => {
    if (secondsLeft <= 0) {
      router.replace('/');
      return;
    }
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft, router]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-xl shadow-lg p-6 sm:p-8 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-red-100 mb-4">
          <ShieldAlert className="w-6 h-6 text-red-600" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Access denied</h1>
        <p className="mt-2 text-sm text-slate-600">
          You don&apos;t have permission to view this page.
        </p>
        <p className="mt-4 text-sm text-slate-500">
          Redirecting to home in {secondsLeft}s…
        </p>
      </div>
    </div>
  );
}
