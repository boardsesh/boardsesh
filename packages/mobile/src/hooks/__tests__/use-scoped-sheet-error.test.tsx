// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useScopedSheetError } from '../use-scoped-sheet-error';
it('retires old request errors after record switches and close/reopen', () => {
  const { result, rerender } = renderHook(({ scope, visible }) => useScopedSheetError(scope, visible), {
    initialProps: { scope: 'one', visible: true },
  });
  const firstRequest = result.current.setSubmitError;
  rerender({ scope: 'two', visible: true });
  act(() => firstRequest('Old failure'));
  expect(result.current.submitError).toBeNull();
  const secondRequest = result.current.setSubmitError;
  act(() => secondRequest('Retry here'));
  expect(result.current.submitError).toBe('Retry here');
  rerender({ scope: 'two', visible: false });
  rerender({ scope: 'two', visible: true });
  act(() => secondRequest('Late hidden failure'));
  expect(result.current.submitError).toBeNull();
  act(() => result.current.setSubmitError('Current failure'));
  expect(result.current.submitError).toBe('Current failure');
});
