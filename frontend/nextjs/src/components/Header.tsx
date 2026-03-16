'use client';

import React from 'react';
import { signOut, useSession } from 'next-auth/react';
import { LogOut, Layout, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const Header = () => {
  const { data: session } = useSession();
  const isOpsTeam = session?.is_ops_team;
  const pathname = usePathname();
  const isLayoutEditor = pathname === '/editor/layouts';

  return (
    <header className="h-16 border-b bg-white flex items-center justify-between px-6 sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 flex items-center justify-center">
          <img src="/logo.png" alt="Product Editor Logo" className="w-full h-full object-contain rounded-lg shadow-sm" />
        </div>
        <span className="font-bold text-xl text-slate-900 tracking-tight">Product Editor</span>
      </div>

      <div className="flex items-center gap-6">
        {isOpsTeam && (
          <Link
            href={isLayoutEditor ? '/dashboard' : '/editor/layouts'}
            className="flex items-center gap-2 text-sm font-medium text-slate-600 hover:text-indigo-600 transition-colors"
          >
            {isLayoutEditor ? (
              <><Layout className="w-4 h-4" /> Dashboard</>
            ) : (
              <><Settings className="w-4 h-4" /> Layout Creator</>
            )}
          </Link>
        )}

        <div className="flex items-center gap-4 pl-6 border-l">
          <div className="flex flex-col items-end">
            <span className="text-sm font-semibold text-slate-900">{session?.user?.name}</span>
            <span className="text-xs text-slate-500">{isOpsTeam ? 'Operations Team' : 'User'}</span>
          </div>
          
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-all"
            title="Sign Out"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  );
};
