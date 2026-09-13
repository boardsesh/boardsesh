// Test-only entry point for the database lifecycle. Nothing here may be imported
// from application code — `connection-test-seam.test.ts` fails the build if it is.
//
// The reset lives in connection.ts because that is where the single-flight guard's
// state lives; this barrel exists so the sanctioned import path for it is visibly a
// test path, and so the production barrel (./index.ts) can stay free of it.
export { resetDatabaseInitializationForTests } from './connection';
// `connection-pin` imports expo-sqlite for TYPES only, so unlike the retention reset
// below it erases at build time and is safe to route through this barrel.
export { resetDatabasePinsForTests } from './connection-pin';
// `resetConnectionRetentionForTests` deliberately does NOT come through here.
// ./connection-retention imports expo-sqlite for real, whose entry reaches
// react-native's Flow source — unparseable by Rolldown's collection-time scan — so
// re-exporting it would break every node-env suite that only wanted the init reset
// (db/__tests__/connection.test.ts among them). Suites that need it import it from
// './connection-retention' directly, having mocked expo-sqlite.
