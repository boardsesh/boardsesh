'use client';

import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import AuthModal from '@/app/components/auth/auth-modal';

type AuthModalConfig = {
  title?: string;
  description?: string;
  /**
   * Where OAuth drops the climber back. `onSuccess` only ever fires for the
   * email/password path, which stays on the page; a social sign-in leaves the
   * app entirely and comes back through next-auth's redirect, so an intent that
   * isn't in this URL is gone (SocialLoginButtons otherwise defaults to '/').
   */
  callbackUrl?: string;
  onSuccess?: () => void;
};

type AuthModalContextValue = {
  openAuthModal: (config?: AuthModalConfig) => void;
};

const AuthModalContext = createContext<AuthModalContextValue>({
  openAuthModal: () => {},
});

export const useAuthModal = () => useContext(AuthModalContext);

export function AuthModalProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hasOpenedOnce, setHasOpenedOnce] = useState(false);
  const [config, setConfig] = useState<AuthModalConfig>({});
  const onSuccessRef = useRef<(() => void) | undefined>(undefined);

  const openAuthModal = useCallback((cfg: AuthModalConfig = {}) => {
    onSuccessRef.current = cfg.onSuccess;
    setConfig({ title: cfg.title, description: cfg.description, callbackUrl: cfg.callbackUrl });
    setHasOpenedOnce(true);
    setOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleSuccess = useCallback(() => {
    const cb = onSuccessRef.current;
    setOpen(false);
    onSuccessRef.current = undefined;
    cb?.();
  }, []);

  return (
    <AuthModalContext.Provider value={{ openAuthModal }}>
      {children}
      {hasOpenedOnce && (
        <AuthModal
          open={open}
          onClose={handleClose}
          onSuccess={handleSuccess}
          title={config.title}
          description={config.description}
          callbackUrl={config.callbackUrl}
        />
      )}
    </AuthModalContext.Provider>
  );
}
