import { describe, it, expect } from 'vite-plus/test';
import React from 'react';
import { render } from '@testing-library/react';
import dayjs from 'dayjs';
import { FormDateTimePicker } from '../form-date-time-picker';

function renderPicker(element: React.ReactElement) {
  return render(element);
}

// MUI X v8's accessible field DOM splits the wiring: `id` lands on the hidden
// <input>, while aria-* / placeholder land on the sectioned field element. The
// assertions below query by attribute rather than assuming one host element.
const hiddenInput = (container: HTMLElement) => container.querySelector('input') as HTMLInputElement;

describe('FormDateTimePicker', () => {
  it('forwards id, error, and describedBy onto the picker field', () => {
    const { container } = renderPicker(
      <FormDateTimePicker id="climbed-at" error describedBy="climbed-at-helper" value={dayjs('2026-07-16')} />,
    );
    expect(hiddenInput(container).id).toBe('climbed-at');
    expect(container.querySelector('[aria-describedby="climbed-at-helper"]')).toBeTruthy();
    expect(container.querySelector('[aria-invalid="true"]')).toBeTruthy();
  });

  it('merges an object textField slot, with injected wiring winning on conflicts', () => {
    const { container } = renderPicker(
      <FormDateTimePicker
        id="injected-id"
        value={dayjs('2026-07-16')}
        slotProps={{ textField: { id: 'caller-id', placeholder: 'caller placeholder', size: 'small' } }}
      />,
    );
    // Injected id wins over the caller's; the caller's other props survive.
    expect(hiddenInput(container).id).toBe('injected-id');
    expect(container.querySelector('[placeholder="caller placeholder"]')).toBeTruthy();
    expect(container.querySelector('.MuiPickersInputBase-root')).toBeTruthy();
  });

  it('merges a function textField slot the same way', () => {
    const { container } = renderPicker(
      <FormDateTimePicker
        id="injected-id"
        describedBy="helper-id"
        value={dayjs('2026-07-16')}
        slotProps={{ textField: () => ({ id: 'caller-id', placeholder: 'from function' }) }}
      />,
    );
    expect(hiddenInput(container).id).toBe('injected-id');
    expect(container.querySelector('[placeholder="from function"]')).toBeTruthy();
    expect(container.querySelector('[aria-describedby="helper-id"]')).toBeTruthy();
  });

  it('leaves caller-supplied wiring untouched when nothing is injected', () => {
    const { container } = renderPicker(
      <FormDateTimePicker value={dayjs('2026-07-16')} slotProps={{ textField: { id: 'caller-id' } }} />,
    );
    expect(hiddenInput(container).id).toBe('caller-id');
  });
});
