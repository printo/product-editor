'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { signOut, useSession } from 'next-auth/react';
import { useHeader } from '@/context/HeaderContext';
import { HeaderBrand } from '@/components/HeaderBrand';
import { HeaderUserMenu } from '@/components/HeaderUserMenu';
import { SegmentedNav } from '@/components/ui/SegmentedNav';
import { ubuntu } from '@/lib/site-fonts';

export const Header = () => {
  const [mounted, setMounted] = React.useState(false);
  const { title, description, centerActions, rightActions, headerHeight, setHeaderHeight } = useHeader();
  const { data: session } = useSession();
  const isOpsTeam = session?.is_ops_team;
  const pathname = usePathname();
  // Highlight "Templates" tab for the layouts list AND any sub-editor pages
  // (e.g. /editor/layouts/calendar/new, /editor/layouts/calendar/[name])
  const isLayoutEditor = pathname === '/editor/layouts' || pathname.startsWith('/editor/layouts/');
  const headerRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // Row content varies per page (e.g. the mobile search row only exists when
  // a page sets centerActions) and per breakpoint, so measure the real
  // rendered height instead of hardcoding it — every spacer/sticky-offset
  // elsewhere reads this back via useHeader().headerHeight.
  React.useLayoutEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    // Measure synchronously first (covers content/breakpoint changes React
    // already re-rendered for, e.g. centerActions appearing/disappearing) —
    // don't rely solely on the observer callback, which can lag a frame.
    setHeaderHeight(Math.round(el.getBoundingClientRect().height));
    // ResizeObserver stays on as a safety net for size changes CSS alone
    // causes without a React re-render (e.g. a window resize that crosses
    // the md breakpoint and toggles the search row's `md:hidden`).
    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (height) setHeaderHeight(Math.round(height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [setHeaderHeight, mounted, centerActions]);

  if (!mounted) {
    return <header style={{ height: headerHeight }} className="border-b border-slate-100 bg-white fixed top-0 left-0 right-0 z-[2000]" />;
  }

  return (
    <header ref={headerRef} className="border-b border-slate-100 bg-[#EFEAF3] flex flex-col fixed top-0 left-0 right-0 z-[2000] shadow-[0_1px_2px_rgba(0,0,0,0.02)]">
      {/* Row 1: Brand + Actions — the only row on desktop; on mobile this is the sticky top bar */}
      <div className="h-[72px] md:h-20 flex items-center justify-between px-4 md:px-6">
        {/* Left: Branding & Context — the context block flexes/truncates on mobile
            (no room for a fixed 280px column there) and locks to the fixed desktop width at md+ */}
        <div className="flex items-center gap-3 md:gap-6 flex-1 min-w-0 md:flex-none md:w-[480px] md:shrink-0">
          <HeaderBrand />

          {/* Page context — only rendered when a page actually sets a title.
              Pages that set none (dashboard, template library, the canvas
              editor) get brand-only, with no divider and no placeholder text. */}
          {title && (
            <>
              <div className="block w-px h-6 md:h-7 bg-slate-300 shrink-0" />

              <div className="flex flex-col flex-1 min-w-0 md:flex-none md:w-[280px] md:shrink-0 overflow-hidden">
                <span className={`${ubuntu.className} text-xs md:text-[13px] font-medium text-slate-900/90 uppercase tracking-tight leading-none truncate`}>
                  {title}
                </span>
                {description && (
                  <p className={`${ubuntu.className} text-[11px] text-slate-600/90 font-light uppercase tracking-wider mt-1 truncate`}>
                    {description}
                  </p>
                )}
              </div>
            </>
          )}
        </div>

        {/* Center: Universal Search / Centerpiece — desktop only; mobile gets its own full-width row below.
            No overflow-hidden here: centerActions can include a Dropdown (e.g. TagFilter) whose open
            panel is position:absolute and must paint outside this row, not get clipped by it. Content
            (SearchInput min-w-0, fixed-width TagFilter/Fonts) already shrinks to fit via flex, so this
            never needed the clip for horizontal safety. */}
        <div className="hidden md:flex flex-1 justify-center px-2 md:px-4 min-w-0">
          {centerActions}
        </div>

        {/* Right: Actions & Universal Nav — page action slot stays visible on mobile (pages
            provide a compact icon-only variant there); the Dashboard/Templates toggle hides
            on mobile here and reappears in row 2 below instead */}
        <div className="flex items-center gap-3 md:gap-4 md:w-[480px] justify-end shrink-0">
          {rightActions && (
            <div className="flex items-center gap-2 md:pr-3 md:border-r md:border-slate-100 shrink-0">
              {rightActions}
            </div>
          )}

          {!!session && (
            <div className="hidden md:block">
              <SegmentedNav
                items={[
                  { href: '/dashboard', label: 'Dashboard', active: !isLayoutEditor },
                  { href: '/editor/layouts', label: 'Templates', active: isLayoutEditor },
                ]}
              />
            </div>
          )}

          <HeaderUserMenu
            name={session?.user?.name}
            roleLabel={isOpsTeam ? 'Operations Team' : 'Designer'}
            onSignOut={() => signOut({ callbackUrl: '/login' })}
          />
        </div>
      </div>

      {/* Row 2: Search + Dashboard/Templates toggle — mobile only, sits directly below the
          sticky top bar. Only rendered when a page actually sets centerActions, so pages
          without a search box (e.g. the canvas editor) don't carry a dead empty strip — the
          ResizeObserver above picks up the resulting height change automatically. */}
      {centerActions && (
        <div className="md:hidden h-14 px-4 pb-3 flex items-center justify-between gap-2">
          {centerActions}
          {!!session && (
            <SegmentedNav
              items={[
                { href: '/dashboard', label: 'Dashboard', active: !isLayoutEditor },
                { href: '/editor/layouts', label: 'Templates', active: isLayoutEditor },
              ]}
            />
          )}
        </div>
      )}
    </header>
  );
};
