// @vitest-environment jsdom
//
// The browser fork of the off-the-row refusal notice. Metro picks it for the web
// target by its `.web` suffix; Vitest does not, so it is imported by name here.
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../../providers/toast-provider', () => ({ useToast: () => ({ showToast }) }));

import { useTrainingConsentRefusalNotice } from '../use-training-consent-refusal-notice.web';

beforeEach(() => {
  showToast.mockReset();
});

describe('useTrainingConsentRefusalNotice on the browser app', () => {
  it('raises an error toast, where a native alert would do nothing', () => {
    const { result } = renderHook(() => useTrainingConsentRefusalNotice());
    result.current('mobile.sprayTraining.updateError');
    expect(showToast).toHaveBeenCalledExactlyOnceWith('mobile.sprayTraining.updateError', 'error');
  });

  it('hands back the same function while the toast provider does', () => {
    const { result, rerender } = renderHook(() => useTrainingConsentRefusalNotice());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
