import * as Sentry from '@sentry/node';
import { resolveBackendTracesSampleRate } from '../../lib/sentry-sampling';

// Runs the real server in a child, because what a stray rejection does depends
// on the process-level listeners, and the test runner installs its own. With
// `enabled: false` Sentry sets up no integrations, so nothing listens for
// `unhandledRejection`; with `enabled: true` its default integration does.

// instrument.ts falls back to the production DSN, so this fixture never imports
// it and refuses to start without a loopback sink to report to.
const sentryDsn = process.env.MALFORMED_REQUEST_SENTRY_DSN ?? 'invalid:';
if (!process.send || process.env.NODE_ENV !== 'test' || new URL(sentryDsn).hostname !== '127.0.0.1') {
  throw new Error('This fixture only runs from its test, reporting to a loopback Sentry sink');
}

const sentryMode = process.argv[2];
Sentry.init({
  dsn: sentryDsn,
  enabled: sentryMode === 'sentry-on',
  // The production sampler made certain: whatever it would ever record, record.
  tracesSampler: ({ name, attributes, normalizedRequest, parentSampled }) =>
    resolveBackendTracesSampleRate({ name, attributes, normalizedRequest, parentSampled }) > 0 ? 1 : 0,
});

// Imported after Sentry.init, for the same reason instrument.ts is loaded first.
process.env.PORT = '0';
const [{ startServer }, { logger }, { once }] = await Promise.all([
  import('../../server'),
  import('../../utils/logger'),
  import('node:events'),
]);
logger.silent = true;

const { httpServer } = await startServer();
if (!httpServer.listening) await once(httpServer, 'listening');
const address = httpServer.address();
if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address');

process.on('message', (message) => {
  if (message !== 'flush') return;
  void Sentry.flush(5000).then(() => process.send?.({ type: 'flushed' }));
});
process.once('disconnect', () => process.exit(0));
process.send({ type: 'listening', port: address.port });
