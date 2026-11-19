'use client';

import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import Snackbar from '@mui/material/Snackbar';
import Alert, { type AlertColor } from '@mui/material/Alert';
import Button from '@mui/material/Button';
import { themeTokens } from '@/app/theme/theme-config';
import { runIfSessionGenerationCurrent, useSessionGeneration } from '@/app/hooks/use-session-generation';

type SnackbarAction = {
  label: string;
  onClick: () => void;
};

type SnackbarMessage = {
  key: number;
  text: string;
  severity: AlertColor;
  action?: SnackbarAction;
  duration?: number;
};

type SnackbarContextValue = {
  /**
   * A new function after every account change. An effect that lists it must
   * remember what it already showed, or it shows the toast a second time.
   */
  showMessage: (text: string, severity: AlertColor, action?: SnackbarAction, duration?: number) => void;
};

const SnackbarContext = createContext<SnackbarContextValue>({
  showMessage: () => {},
});

export const useSnackbar = () => useContext(SnackbarContext);

export function SnackbarProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<SnackbarMessage[]>([]);
  // Monotonic key — `Date.now()` collides when two messages are queued within
  // the same millisecond, which corrupts React reconciliation (a duplicate-key
  // snackbar won't dismiss correctly).
  const keyCounterRef = useRef(0);
  // A caller still holding showMessage from before an account change (say, a
  // request that came back superseded) shows nothing.
  const generation = useSessionGeneration();

  const showMessage = useCallback(
    (text: string, severity: AlertColor, action?: SnackbarAction, duration?: number) => {
      // Shown at once, or after a running viewer check confirms this login; never for another account.
      runIfSessionGenerationCurrent(generation, () => {
        keyCounterRef.current += 1;
        const key = keyCounterRef.current;
        setMessages((prev) => [...prev, { key, text, severity, action, duration }]);
      });
    },
    [generation],
  );
  const contextValue = useMemo(() => ({ showMessage }), [showMessage]);

  const handleClose = useCallback((key: number) => {
    setMessages((prev) => prev.filter((m) => m.key !== key));
  }, []);

  return (
    <SnackbarContext.Provider value={contextValue}>
      {children}
      {messages.map((msg) => (
        <Snackbar
          key={msg.key}
          open
          autoHideDuration={msg.duration ?? 3000}
          onClose={() => handleClose(msg.key)}
          anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
          sx={{ top: `calc(8px + ${themeTokens.layout.safeAreaTop}) !important` }}
        >
          <Alert
            onClose={() => handleClose(msg.key)}
            severity={msg.severity}
            variant="filled"
            sx={{ width: '100%' }}
            action={
              msg.action ? (
                <Button
                  color="inherit"
                  size="small"
                  onClick={() => {
                    msg.action!.onClick();
                    handleClose(msg.key);
                  }}
                  sx={{ fontWeight: 700 }}
                >
                  {msg.action.label}
                </Button>
              ) : undefined
            }
          >
            {msg.text}
          </Alert>
        </Snackbar>
      ))}
    </SnackbarContext.Provider>
  );
}
