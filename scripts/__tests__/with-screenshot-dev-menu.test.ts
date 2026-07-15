/// <reference types="node" />
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

// The plugin reads env loosely (only `env.BOARDSESH_METRO_PORT`, defaulting to
// process.env), so model the param as a bare env-like record rather than
// NodeJS.ProcessEnv — the latter now requires NODE_ENV under @types/node, which
// would reject the `{}` / partial-env fixtures the tests pass.
type EnvLike = Record<string, string | undefined>;
type ScreenshotDevMenuPlugin = {
  applyScreenshotDevMenuInfoPlist: (infoPlist: Record<string, unknown>, env?: EnvLike) => Record<string, unknown>;
  resolveScreenshotMetroPort: (env?: EnvLike) => number;
  resolveScreenshotMetroUrl: (env?: EnvLike) => string;
};

const plugin = require('../../packages/mobile/plugins/with-screenshot-dev-menu.js') as ScreenshotDevMenuPlugin;

describe('with-screenshot-dev-menu', () => {
  it('defaults the baked dev-client launcher URL to the screenshot Metro port', () => {
    expect(plugin.resolveScreenshotMetroPort({})).toBe(8081);
    expect(plugin.resolveScreenshotMetroUrl({})).toBe('http://localhost:8081');
  });

  it('uses BOARDSESH_METRO_PORT for the baked dev-client launcher URL', () => {
    const infoPlist = plugin.applyScreenshotDevMenuInfoPlist({}, { BOARDSESH_METRO_PORT: '8091' });

    expect(infoPlist.DEV_CLIENT_DEFAULT_LAUNCHER_URL).toBe('http://localhost:8091');
    expect(infoPlist.EXDevMenuIsOnboardingFinished).toBe(true);
    expect(infoPlist.EXDevMenuShowFloatingActionButton).toBe(false);
    expect(infoPlist.EXDevMenuShowsAtLaunch).toBe(false);
  });
});
