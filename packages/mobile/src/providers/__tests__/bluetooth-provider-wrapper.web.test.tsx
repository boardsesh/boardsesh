// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useBlePickerHost } from '../ble-picker-host';
import { BluetoothProviderWrapper } from '../bluetooth-provider-wrapper.web';

function PickerHostProbe() {
  const pickerHost = useBlePickerHost();
  return <div data-testid="picker-state">{pickerHost.pickerState === null ? 'inactive' : 'active'}</div>;
}

describe('BluetoothProviderWrapper on web', () => {
  afterEach(cleanup);

  it('renders children with an inert picker host and no unsupported Bluetooth provider', () => {
    const { getByTestId } = render(
      <BluetoothProviderWrapper>
        <div data-testid="child" />
        <PickerHostProbe />
      </BluetoothProviderWrapper>,
    );

    expect(getByTestId('child')).toBeTruthy();
    expect(getByTestId('picker-state').textContent).toBe('inactive');
  });
});
