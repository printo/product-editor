'use client';

import { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { HeaderProvider } from '@/context/HeaderContext';
import { Header } from '@/components/Header';

export const AppWrapper = ({ children }: { children: ReactNode }) => {
  const pathname = usePathname();
  const isLoginPage = pathname === '/login';

  return (
    <HeaderProvider>
      {!isLoginPage && (
        <>
          <Header />
          <div className="h-16" /> {/* Spacer for fixed header */}
        </>
      )}
      {children}
    </HeaderProvider>
  );
};
