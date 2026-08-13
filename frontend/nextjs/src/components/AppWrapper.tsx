'use client';

import { ReactNode, useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';
import { HeaderProvider, useHeader } from '@/context/HeaderContext';
import { Header } from '@/components/Header';
import { initObservability } from '@/lib/observability';

// Must be a child of HeaderProvider (not a sibling) so it can read the
// ResizeObserver-measured headerHeight and always match the real header.
const HeaderSpacer = () => {
  const { headerHeight } = useHeader();
  return <div style={{ height: headerHeight }} />;
};

// "Have we hydrated yet?" without a setState-in-effect cascade. The store
// never emits, so this settles once at hydration and never re-renders again.
const subscribeNever = () => () => {};
const useHasHydrated = () =>
  useSyncExternalStore(subscribeNever, () => true, () => false);

export const AppWrapper = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  // /editor/layout/[name] is the one route serving BOTH flows: dashboard staff
  // open it with a NextAuth session, the printo.in iframe opens it with
  // ?token=. Only the query string tells them apart, and a root layout can't
  // read searchParams during SSR — so on this route alone the header is
  // withheld until the client resolves which flow it is. Rendering it first
  // and hiding it after would flash the Printo brand bar, user name, and
  // Logout button inside the customer's iframe for the whole hydration of a
  // very heavy page. Every other route keeps its server-rendered header.
  // Note the trailing slash: it excludes /editor/layouts (template library).
  const isSharedEditorRoute = pathname.startsWith('/editor/layout/');
  const hydrated = useHasHydrated();

  useEffect(() => {
    initObservability();
  }, []);

  // Read on every render rather than cached in state: a client-side nav
  // changes window.location without remounting this component.
  const showHeader = isSharedEditorRoute
    ? hydrated && !new URLSearchParams(window.location.search).has('token')
    : true;

  const headerMounted = !isLoginPage && showHeader;

  return (
    <HeaderProvider headerless={!headerMounted}>
      {headerMounted && (
        <>
          <Header />
          <HeaderSpacer />
        </>
      )}
      {children}
    </HeaderProvider>
  );
};

