'use client';

import React, { createContext, useContext, useState, ReactNode } from 'react';

interface HeaderContextType {
  title: string;
  setTitle: (title: string) => void;
  description: string;
  setDescription: (desc: string) => void;
  centerActions: ReactNode;
  setCenterActions: (actions: ReactNode) => void;
  rightActions: ReactNode;
  setRightActions: (actions: ReactNode) => void;
  // Actual rendered height (px) of the fixed <header>, kept in sync by a
  // ResizeObserver in Header.tsx. Row content (e.g. the mobile search row)
  // varies per page, so any spacer/sticky-offset that sits under the header
  // should read this instead of a hardcoded height class.
  headerHeight: number;
  setHeaderHeight: (height: number) => void;
}

const HeaderContext = createContext<HeaderContextType | undefined>(undefined);

// Desktop single-row height — used as the pre-measurement default so the
// very first paint (before the ResizeObserver reports back) isn't 0.
const DEFAULT_HEADER_HEIGHT = 80;

export const HeaderProvider = ({
  children,
  headerless = false,
}: {
  children: ReactNode;
  /** No <header> is mounted (embed iframe) — consumers must offset by 0, not
   *  by the pre-measurement default. Without this the editor's sticky toolbar
   *  hangs 80px below the viewport top on a headerless page, because the
   *  ResizeObserver that would have corrected the default never runs. */
  headerless?: boolean;
}) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [centerActions, setCenterActions] = useState<ReactNode>(null);
  const [rightActions, setRightActions] = useState<ReactNode>(null);
  const [headerHeight, setHeaderHeight] = useState(DEFAULT_HEADER_HEIGHT);

  return (
    <HeaderContext.Provider value={{
      title, setTitle,
      description, setDescription,
      centerActions, setCenterActions,
      rightActions, setRightActions,
      headerHeight: headerless ? 0 : headerHeight, setHeaderHeight,
    }}>
      {children}
    </HeaderContext.Provider>
  );
};

export const useHeader = () => {
  const context = useContext(HeaderContext);
  if (!context) throw new Error('useHeader must be used within a HeaderProvider');
  return context;
};
