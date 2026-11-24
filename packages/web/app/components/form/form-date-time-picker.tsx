'use client';

import * as React from 'react';
import { DateTimePicker, type DateTimePickerProps } from '@mui/x-date-pickers/DateTimePicker';
import DatePickerProvider from './date-picker-provider';

export type FormDateTimePickerProps = DateTimePickerProps & {
  /** Control id, forwarded to the picker's text field. */
  id?: string;
  /** Error styling flag, forwarded to the picker's text field. */
  error?: boolean;
  /** id of the field's helper/error text, forwarded as `aria-describedby`. */
  describedBy?: string;
};

/**
 * FormDateTimePicker is a thin wrapper over the x-date-pickers `DateTimePicker` that maps
 * FormField's wiring (`id`, `error`, `describedBy`) into the `textField` slot, merging
 * with any caller-supplied `slotProps` so its own text-field overrides still apply.
 * The injected values win only when provided, so a caller can still set them itself.
 */
export function FormDateTimePicker({ id, error, describedBy, slotProps, ...rest }: FormDateTimePickerProps) {
  const injectedTextField = {
    ...(id !== undefined ? { id } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(describedBy !== undefined ? { 'aria-describedby': describedBy } : {}),
  };
  const callerTextField = slotProps?.textField;

  return (
    <DatePickerProvider>
      <DateTimePicker
        {...rest}
        slotProps={{
          ...slotProps,
          textField:
            typeof callerTextField === 'function'
              ? (ownerState) => ({ ...callerTextField(ownerState), ...injectedTextField })
              : { ...callerTextField, ...injectedTextField },
        }}
      />
    </DatePickerProvider>
  );
}
