'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';
import { useSnackbar } from './snackbar-provider';

const STACK_OVERFLOW_MESSAGE = 'Maximum call stack';

/**
 * Last-resort handler for unhandled stack-overflow errors thrown outside of
 * React's render cycle (RAF callbacks, microtasks, async event listeners,
 * etc.). React error boundaries — including `app/global-error.tsx` — can't
 * catch these; they reach the browser as `window.onerror` and Sentry tags
 * them with `mechanism: auto.browser.global_handlers.onerror`.
 *
 * This component:
 * 1. Re-captures the error to Sentry with extra browser context, since the
 *    default `onerror` capture path tends to lose frames on iOS WebKit.
 * 2. Surfaces a snackbar so the user sees something actionable instead of
 *    the page silently freezing or going blank.
 *
 * This is a guard rail, not a fix — it makes recurring iOS Chrome
 * `RangeError: Maximum call stack size exceeded` reports less invisible
 * while we wait for symbolicated stacks to identify the recursion.
 */
export function GlobalErrorTrap() {
  const { showMessage } = useSnackbar();

  useEffect(() => {
    const handler = (event: ErrorEvent) => {
      const err = event.error;
      if (!(err instanceof RangeError)) return;
      if (!err.message?.includes(STACK_OVERFLOW_MESSAGE)) return;

      Sentry.captureException(err, {
        tags: { kind: 'stack-overflow-trap' },
        extra: {
          url: typeof location !== 'undefined' ? location.href : null,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
        },
      });

      showMessage('Something looped on this page. We logged it — try reloading.', 'warning', undefined, 6000);
    };

    window.addEventListener('error', handler);
    return () => window.removeEventListener('error', handler);
  }, [showMessage]);

  return null;
}
