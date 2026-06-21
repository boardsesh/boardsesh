import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

type ManifestElement = {
  $: Record<string, string>;
};

type AndroidManifestShape = {
  manifest: {
    application?: Array<{
      $: Record<string, string>;
      service?: ManifestElement[];
      receiver?: ManifestElement[];
    }>;
  };
};

type SessionServicePlugin = {
  addSessionService(manifest: AndroidManifestShape): AndroidManifestShape;
  SERVICE_NAME: string;
  RECEIVER_NAME: string;
};

const plugin = require('../../../plugins/with-android-session-service.js') as SessionServicePlugin;

function baseManifest(): AndroidManifestShape {
  return { manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] } };
}

describe('with-android-session-service', () => {
  it('injects the foreground service with the connectedDevice type, not exported', () => {
    const application = plugin.addSessionService(baseManifest()).manifest.application?.[0];
    const service = application?.service?.find((entry) => entry.$['android:name'] === plugin.SERVICE_NAME);

    expect(service).toBeDefined();
    expect(service?.$['android:foregroundServiceType']).toBe('connectedDevice');
    expect(service?.$['android:exported']).toBe('false');
  });

  it('injects the action receiver, not exported', () => {
    const application = plugin.addSessionService(baseManifest()).manifest.application?.[0];
    const receiver = application?.receiver?.find((entry) => entry.$['android:name'] === plugin.RECEIVER_NAME);

    expect(receiver).toBeDefined();
    expect(receiver?.$['android:exported']).toBe('false');
  });

  it('is idempotent — a second pass adds no duplicates', () => {
    const once = plugin.addSessionService(baseManifest());
    const twice = plugin.addSessionService(once);
    const application = twice.manifest.application?.[0];

    const services = (application?.service ?? []).filter((entry) => entry.$['android:name'] === plugin.SERVICE_NAME);
    const receivers = (application?.receiver ?? []).filter((entry) => entry.$['android:name'] === plugin.RECEIVER_NAME);

    expect(services).toHaveLength(1);
    expect(receivers).toHaveLength(1);
  });
});
