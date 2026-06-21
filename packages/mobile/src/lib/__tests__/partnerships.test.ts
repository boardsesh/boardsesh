import { describe, it, expect, vi, beforeEach } from 'vitest';

const linking = vi.hoisted(() => ({ openURL: vi.fn() }));
const reporting = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock('react-native', () => ({ Linking: linking }));
vi.mock('../error-reporting', () => reporting);

import { openPartnershipsEmail, PARTNERSHIPS_EMAIL } from '../partnerships';

beforeEach(() => {
  linking.openURL.mockReset();
  reporting.reportError.mockReset();
});

describe('openPartnershipsEmail', () => {
  it('opens a mailto to the partnerships inbox and reports success', async () => {
    linking.openURL.mockResolvedValue(undefined);

    const opened = await openPartnershipsEmail();

    expect(opened).toBe(true);
    expect(linking.openURL).toHaveBeenCalledTimes(1);
    expect(linking.openURL.mock.calls[0][0]).toContain(`mailto:${PARTNERSHIPS_EMAIL}`);
    expect(reporting.reportError).not.toHaveBeenCalled();
  });

  it('returns false and reports when no mail handler is available', async () => {
    linking.openURL.mockRejectedValue(new Error('no handler'));

    const opened = await openPartnershipsEmail();

    expect(opened).toBe(false);
    expect(reporting.reportError).toHaveBeenCalledTimes(1);
  });
});
