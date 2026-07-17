import { setAnalyticsBootstrapId } from './analytics-bootstrap-id';

// Native can synchronously seed PostHog from SecureStore. IndexedDB is async, so
// the browser starts anonymous and PartyProfileProvider reconciles once loaded.
setAnalyticsBootstrapId(null);
