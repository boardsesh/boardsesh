import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    const { shutdownServerAnalytics } = await import('./app/lib/analytics.server');
    const onShutdown = () => {
      void shutdownServerAnalytics();
    };
    process.once('SIGTERM', onShutdown);
    process.once('SIGINT', onShutdown);
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
