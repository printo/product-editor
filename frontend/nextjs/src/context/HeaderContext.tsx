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
}

const HeaderContext = createContext<HeaderContextType | undefined>(undefined);

export const HeaderProvider = ({ children }: { children: ReactNode }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [centerActions, setCenterActions] = useState<ReactNode>(null);
  const [rightActions, setRightActions] = useState<ReactNode>(null);

  return (
    <HeaderContext.Provider value={{
      title, setTitle,
      description, setDescription,
      centerActions, setCenterActions,
      rightActions, setRightActions
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
