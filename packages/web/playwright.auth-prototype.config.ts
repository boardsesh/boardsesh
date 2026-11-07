import { defineConfig } from '@playwright/test';

/** A synthetic HTTPS authority and disposable Postgres; no product server or real accounts. */
export default defineConfig({
  testDir: './auth-prototype',
  workers: 1,
  retries: 0,
  timeout: 60000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: ['--host-resolver-rules=MAP *.boardsesh.test 127.0.0.1', '--no-proxy-server'],
    },
  },
});
