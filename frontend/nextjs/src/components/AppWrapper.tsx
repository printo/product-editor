'use client';

import { ReactNode, useEffect } from 'react';
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

export const AppWrapper = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  useEffect(() => {
    initObservability();
  }, []);

  return (
    <HeaderProvider>
      {!isLoginPage && (
        <>
          <Header />
          <HeaderSpacer />
        </>
      )}
      {children}
    </HeaderProvider>
  );
};

