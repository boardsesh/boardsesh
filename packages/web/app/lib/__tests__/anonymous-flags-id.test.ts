import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { getPreference } from '../user-preferences-db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadModule() {
  vi.resetModules();
  return import('../anonymous-flags-id');
}

describe('getAnonymousFlagsId', () => {
  beforeEach(async () => {
    const { removePreference } = await import('../user-preferences-db');
    await removePreference('anonymousFlagsId');
  });

  it('creates one random id and keeps it in IndexedDB across page loads', async () => {
    const firstLoad = await loadModule();
    const id = await firstLoad.getAnonymousFlagsId();
    expect(id).toMatch(UUID);
    expect(await getPreference('anonymousFlagsId')).toBe(id);

    const secondLoad = await loadModule();
    expect(await secondLoad.getAnonymousFlagsId()).toBe(id);
    expect(await secondLoad.getFlagsBrowserDistinctId()).toBe(`flags-browser:${id}`);
  });
});

describe('withAnonymousFlagsIdentity', () => {
  const body = JSON.stringify({
    token: 'phc',
    distinct_id: 'sdk-anonymous',
    $anon_distinct_id: 'sdk-anonymous',
    $device_id: 'sdk-device',
    person_properties: { $browser: 'Firefox' },
  });

  it('buckets on the browser id and drops the SDK ids without consent', async () => {
    const { withAnonymousFlagsIdentity } = await loadModule();
    expect(JSON.parse(withAnonymousFlagsIdentity(body, 'flags-browser:abc', false))).toEqual({
      token: 'phc',
      distinct_id: 'flags-browser:abc',
      person_properties: { $browser: 'Firefox' },
    });
  });

  it('keeps the SDK ids beside the browser id with consent', async () => {
    const { withAnonymousFlagsIdentity } = await loadModule();
    expect(JSON.parse(withAnonymousFlagsIdentity(body, 'flags-browser:abc', true))).toMatchObject({
      distinct_id: 'flags-browser:abc',
      $anon_distinct_id: 'sdk-anonymous',
      $device_id: 'sdk-device',
    });
  });

  it('leaves a body that is not a JSON object alone', async () => {
    const { withAnonymousFlagsIdentity } = await loadModule();
    expect(withAnonymousFlagsIdentity('not json', 'flags-browser:abc', false)).toBe('not json');
    expect(withAnonymousFlagsIdentity('[1]', 'flags-browser:abc', false)).toBe('[1]');
  });
});
