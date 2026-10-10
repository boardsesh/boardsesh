// @vitest-environment jsdom
//
// The native off-the-row refusal notice: an alert, never a toast.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const alertMock = vi.hoisted(() => vi.fn());
vi.mock('react-native', () => ({ Alert: { alert: alertMock } }));

import { useTrainingConsentRefusalNotice } from '../use-training-consent-refusal-notice';

beforeEach(() => {
  alertMock.mockReset();
});

describe('useTrainingConsentRefusalNotice on a phone', () => {
  it('raises a native alert with the message as its title', () => {
    const { result } = renderHook(() => useTrainingConsentRefusalNotice());
    result.current('mobile.sprayTraining.updateError');
    expect(alertMock).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError');
  });
});
