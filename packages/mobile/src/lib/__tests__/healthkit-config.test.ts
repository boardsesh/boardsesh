import type { ConfigContext, ExpoConfig } from 'expo/config';
import { describe, expect, it } from 'vitest';

import createExpoConfig from '../../../app.config';

function buildConfig(): ExpoConfig & { newArchEnabled?: boolean } {
  const previousTailscaleHosts = process.env.TAILSCALE_HOSTS;
  process.env.TAILSCALE_HOSTS = '';

  try {
    return createExpoConfig({
      config: {
        name: 'Boardsesh',
        slug: 'boardsesh',
      },
    } as ConfigContext);
  } finally {
    if (previousTailscaleHosts === undefined) {
      delete process.env.TAILSCALE_HOSTS;
    } else {
      process.env.TAILSCALE_HOSTS = previousTailscaleHosts;
    }
  }
}

describe('mobile HealthKit native config', () => {
  it('declares the HealthKit usage descriptions in the static Expo plist config', () => {
    const config = buildConfig();

    expect(config.ios?.infoPlist).toMatchObject({
      NSHealthUpdateUsageDescription: 'Boardsesh saves your finished climbing sessions to Apple Health as workouts.',
      NSHealthShareUsageDescription:
        'Boardsesh reads your body weight to estimate calories and your saved Boardsesh workouts to prevent duplicates.',
    });
  });

  it('registers the HealthKit config plugin for the entitlement', () => {
    const config = buildConfig();

    expect(config.plugins).toContain('./plugins/with-healthkit');
  });
});
