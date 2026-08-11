// Test-only entry point for the database lifecycle. Nothing here may be imported
// from application code — `connection-test-seam.test.ts` fails the build if it is.
//
// The reset lives in connection.ts because that is where the single-flight guard's
// state lives; this barrel exists so the sanctioned import path for it is visibly a
// test path, and so the production barrel (./index.ts) can stay free of it.
export { resetDatabaseInitializationForTests } from './connection';
