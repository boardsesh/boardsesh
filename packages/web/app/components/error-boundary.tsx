'use client';

import React, { Component, type ReactNode } from 'react';

const MAX_RECOVERY_ATTEMPTS = 3;
/** Reset the retry counter after this many ms without errors. */
const RETRY_RESET_MS = 30_000;

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * When true, automatically reset the error state so children remount
   * instead of permanently showing the fallback. Useful for transient DOM
   * errors caused by browser extensions or auto-translate modifying the DOM.
   * Retries up to 3 times in quick succession before falling back permanently.
   * The retry budget resets after 30 s of error-free operation. That reset only
   * helps a boundary that is currently rendering fine: once the budget is spent
   * the boundary stays on the fallback, because zeroing the counter never
   * clears `hasError` and unmounted children cannot throw again.
   */
  recoverable?: boolean;
};

type ErrorBoundaryState = {
  hasError: boolean;
  retryCount: number;
};

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  private rafHandle: number | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, retryCount: 0 };
  }

  static getDerivedStateFromError(): Pick<ErrorBoundaryState, 'hasError'> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo);

    if (this.props.recoverable && this.state.retryCount < MAX_RECOVERY_ATTEMPTS) {
      // Schedule a reset so the children remount on the next frame.
      // This recovers from transient DOM corruption (e.g. Chrome translate
      // wrapping text nodes in <font> tags, causing removeChild errors).
      this.rafHandle = requestAnimationFrame(() => {
        this.rafHandle = null;
        this.setState((s) => ({ hasError: false, retryCount: s.retryCount + 1 }));
        this.scheduleRetryReset();
      });
    }
  }

  componentWillUnmount() {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle);
    }
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
    }
  }

  /** After a quiet period, reset the retry budget so future errors can recover. */
  private scheduleRetryReset() {
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
    }
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.setState({ retryCount: 0 });
    }, RETRY_RESET_MS);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}
