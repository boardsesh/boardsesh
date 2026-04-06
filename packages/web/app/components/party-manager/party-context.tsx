'use client';

import React, { useContext, createContext, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import { useSessionData } from '../graphql-queue';

type ConnectedUser = {
  username: string;
  avatar?: string;
  id: string;
  isHost?: boolean;
};

type PartyContextType = {
  userName: string;
  connectedUsers: ConnectedUser[];
};

const PartyContext = createContext<PartyContextType | undefined>(undefined);

export const PartyProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data: session } = useSession();
  const { users, clientId, isBackendMode, hasConnected } = useSessionData();

  const username = session?.user?.name || '';

  // Convert SessionUser[] to ConnectedUser[]
  const connectedUsers: ConnectedUser[] = useMemo(() => {
    if (!isBackendMode || !hasConnected || !users) return [];
    return users
      .filter((user) => user.id !== clientId)
      .map((user) => ({
        username: user.username,
        id: user.id,
        isHost: user.isLeader,
      }));
  }, [users, clientId, isBackendMode, hasConnected]);

  // Get the effective username based on mode
  const effectiveUserName = useMemo(() => {
    if (isBackendMode && hasConnected && users) {
      return users.find((u) => u.id === clientId)?.username || username || clientId || '';
    }
    return username || '';
  }, [isBackendMode, hasConnected, users, clientId, username]);

  const contextValue: PartyContextType = {
    userName: effectiveUserName,
    connectedUsers,
  };

  return <PartyContext.Provider value={contextValue}>{children}</PartyContext.Provider>;
};

export const usePartyContext = () => {
  const context = useContext(PartyContext);
  if (!context) {
    throw new Error('usePartyContext must be used within a PartyProvider');
  }
  return context;
};

export default PartyContext;
