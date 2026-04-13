'use client';

import React from 'react';
import { LogOut } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { useHeader } from '@/context/HeaderContext';

export const Header = () => {
  const [mounted, setMounted] = React.useState(false);
  const { title, description, centerActions, rightActions } = useHeader();
  const { data: session } = useSession();
  const isOpsTeam = session?.is_ops_team;
  const pathname = usePathname();
  const isLayoutEditor = pathname === '/editor/layouts';

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <header className="h-16 border-b border-slate-100 bg-white fixed top-0 left-0 right-0 z-[2000]" />;
  }

  return (
    <header className="h-16 border-b border-slate-100 bg-white/100 flex items-center px-6 fixed top-0 left-0 right-0 z-[2000] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Left: Branding & Context Header */}
      <div className="flex items-center gap-6 w-[480px] shrink-0">
        {/* Site Branding */}
        <Link href="/dashboard" className="flex items-center gap-3 shrink-0 group transition-opacity hover:opacity-80">
          <div className="w-8 h-8 flex items-center justify-center p-1.5 bg-slate-50 border border-slate-200 rounded-lg group-hover:scale-105 transition-transform shadow-[0_1px_1px_rgba(0,0,0,0.05)]">
            <img src="/favicon.png" alt="Logo" className="w-full h-full object-contain" />
          </div>
          <h1 className="text-[11px] font-black text-slate-900 uppercase tracking-tight w-[100px] shrink-0">
            Product Editor
          </h1>
        </Link>

        {/* Separator */}
        <div className="w-px h-6 bg-slate-100 shrink-0" />

        {/* Page Context (Title/Desc) */}
        <div className="flex flex-col w-[280px] shrink-0 overflow-hidden">
          <span className="text-[10px] font-black text-slate-900 uppercase tracking-tight leading-none truncate">
            {title || 'Dashboard'}
          </span>
          {description && (
            <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-1 truncate">
              {description}
            </p>
          )}
        </div>
      </div>

      {/* Center: Universal Search / Centerpiece */}
      <div className="flex-1 flex justify-center px-4 overflow-hidden">
        {centerActions}
      </div>

      {/* Right: Actions & Universal Nav */}
      <div className="flex items-center gap-4 w-[480px] justify-end shrink-0">
        {/* Page Action Slot */}
        {rightActions && (
          <div className="flex items-center gap-2 pr-3 border-r border-slate-100 shrink-0">
            {rightActions}
          </div>
        )}

        {/* Admin Navigation Toggle */}
        {isOpsTeam && (
          <nav className="flex items-center bg-slate-100/80 p-1 rounded-xl border border-slate-200/40 shrink-0 shadow-inner relative overflow-hidden">
            <Link
              href="/dashboard"
              className={`relative z-10 px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all duration-300 min-w-[100px] text-center ${
                !isLayoutEditor
                  ? 'toggle-active' 
                  : 'toggle-inactive'
              }`}
            >
              Dashboard
            </Link>
            <Link
              href="/editor/layouts"
              className={`relative z-10 px-5 py-2 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all duration-300 min-w-[100px] text-center ${
                isLayoutEditor 
                  ? 'toggle-active' 
                  : 'toggle-inactive'
              }`}
            >
              Templates
            </Link>
          </nav>
        )}

        {/* User Identity & Logout */}
        <div className="flex items-center gap-3 pl-3 shrink-0">
          <div className="flex flex-col items-end hidden lg:flex whitespace-nowrap overflow-hidden">
            <span className="text-[10px] font-black text-slate-900 leading-none">
              {session?.user?.name || 'User'}
            </span>
            <span className="text-[8px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
              {isOpsTeam ? 'Operations Team' : 'Designer'}
            </span>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="p-1 px-2 text-rose-500 hover:bg-rose-50 rounded-md border border-transparent hover:border-rose-100 transition-all hover:scale-105 active:scale-95 shrink-0"
            title="Sign Out"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};
