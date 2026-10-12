// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const installReferrer = vi.hoisted(() => ({ maybeFetchAndAttachInstallReferrer: vi.fn(async () => {}) }));
const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

vi.mock('../../../lib/install-referrer', () => ({
  maybeFetchAndAttachInstallReferrer: installReferrer.maybeFetchAndAttachInstallReferrer,
}));
vi.mock('react-native', () => ({ Platform: platform }));

import { InstallReferrerTracker } from '../InstallReferrerTracker';
import { updateConsentState } from '../../../lib/consent-state';
import { grantAnalyticsForTest, grantedConsent } from '../../../../test/consent-fixture';

beforeEach(() => {
  installReferrer.maybeFetchAndAttachInstallReferrer.mockClear();
  platform.OS = 'android';
});

describe('InstallReferrerTracker', () => {
  it('fetches the install referrer on mount when running on Android', async () => {
    render(createElement(InstallReferrerTracker));

    await waitFor(() => expect(installReferrer.maybeFetchAndAttachInstallReferrer).toHaveBeenCalledTimes(1));
  });

  it('does nothing on iOS — Play Install Referrer has no iOS equivalent', async () => {
    platform.OS = 'ios';

    render(createElement(InstallReferrerTracker));

    // No affirmative "never called" signal exists here, so flush a macrotask
    // boundary (draining the mount effect) before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(installReferrer.maybeFetchAndAttachInstallReferrer).not.toHaveBeenCalled();
  });

  it('runs again when an explicit Allow replaces the region default', async () => {
    // Analytics already on outside the prompt regions; the referrer needs the climber's own Allow.
    grantAnalyticsForTest();
    updateConsentState({ record: { ...grantedConsent, basis: 'region_default' }, regionConfirmed: true });
    render(createElement(InstallReferrerTracker));
    await waitFor(() => expect(installReferrer.maybeFetchAndAttachInstallReferrer).toHaveBeenCalledTimes(1));

    act(() => grantAnalyticsForTest());

    await waitFor(() => expect(installReferrer.maybeFetchAndAttachInstallReferrer).toHaveBeenCalledTimes(2));
  });
});
