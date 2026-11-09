import { createTelemetry, type BetterAuthOptions, type TelemetryEvent } from 'better-auth';
import { describe, expect, it } from 'vite-plus/test';
import { PROTOTYPE_CONFIGURATION } from '../configuration';

/**
 * The event types telemetry would send for these options. `skipTestCheck` turns
 * off the library's own "never under NODE_ENV=test" gate, and `customTrack`
 * receives each event in place of the HTTP call, so this sees what a deployed
 * process would send.
 */
async function eventsPublishedWith(options: BetterAuthOptions): Promise<string[]> {
  const publishedTypes: string[] = [];
  const customTrack = async (event: TelemetryEvent) => {
    publishedTypes.push(event.type);
  };
  const { publish } = await createTelemetry(options, { customTrack, skipTestCheck: true });
  await publish({ type: 'probe', payload: {} });
  return publishedTypes;
}

describe('Better Auth telemetry', () => {
  it('is switched off explicitly rather than left to the default', () => {
    expect(PROTOTYPE_CONFIGURATION.telemetry).toEqual({ enabled: false });
  });

  it('publishes nothing with the pinned configuration', async () => {
    await expect(eventsPublishedWith(PROTOTYPE_CONFIGURATION)).resolves.toEqual([]);
  });

  it('would publish if it were on, so the check above can fail', async () => {
    await expect(eventsPublishedWith({ ...PROTOTYPE_CONFIGURATION, telemetry: { enabled: true } })).resolves.toContain(
      'probe',
    );
  });
});
