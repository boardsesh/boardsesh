import { expect, it, vi } from 'vitest';
import { rememberOtaSuperProperties, reregisterOtaSuperProperties } from '../analytics-ota-context';

it('preserves running bundle identity when canary metadata arrives before analytics consent', () => {
  rememberOtaSuperProperties({ ota_channel: 'production', ota_branch: 'production', ota_update_id: 'running-update' });
  rememberOtaSuperProperties({ ota_automatic_canary: true, ota_canary_checked_at: '2026-10-14T02:00:00.000Z' });
  const client = { register: vi.fn() };
  reregisterOtaSuperProperties(client);
  expect(client.register).toHaveBeenCalledWith({
    ota_channel: 'production',
    ota_branch: 'production',
    ota_update_id: 'running-update',
    ota_automatic_canary: true,
    ota_canary_checked_at: '2026-10-14T02:00:00.000Z',
  });
});
