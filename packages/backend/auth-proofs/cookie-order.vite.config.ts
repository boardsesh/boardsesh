import configuration from './session-publication.vite.config';

// Deliberately failing BA05 acceptance proof; never part of the default suite.
export default {
  ...configuration,
  test: {
    ...configuration.test,
    include: ['src/auth/current-store/__tests__/cookie-order-browser.proof.ts'],
    testTimeout: 40_000,
  },
};
