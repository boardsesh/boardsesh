'use client';

import * as React from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import type { SxProps, Theme } from '@mui/material/styles';

export type FormShellProps = {
  /** Submit handler wired to the underlying `<form>` element. */
  onSubmit: React.FormEventHandler<HTMLFormElement>;
  /** Use a non-form container while a server-rendered form cannot handle submission yet. */
  component?: 'form' | 'div';
  /** Error banner shown above the fields. Any truthy ReactNode renders an alert. */
  error?: React.ReactNode;
  /**
   * Content width cap. Defaults to 640px. Pass `false` to disable capping in dense /
   * dialog contexts where the surrounding container already controls width.
   */
  maxWidth?: number | false;
  children: React.ReactNode;
  sx?: SxProps<Theme>;
  id?: string;
};

/**
 * FormShell is the outer `<form>` primitive of the Velvet form kit.
 *
 * It renders `<Box component="form" noValidate>` (validation is the caller's job — see
 * `focusFirstInvalid`), stacks children in a 24px column, caps content width, and sets
 * `containerType: 'inline-size'` so nested `FormRow`s can use container queries to go
 * multi-column based on the form's own width rather than the viewport.
 */
export function FormShell({ onSubmit, component = 'form', error, maxWidth = 640, children, sx, id }: FormShellProps) {
  const containerSx: SxProps<Theme> = [
    {
      display: 'flex',
      flexDirection: 'column',
      gap: 3,
      width: '100%',
      maxWidth: maxWidth === false ? 'none' : maxWidth,
      mx: 'auto',
      containerType: 'inline-size',
    },
    ...(Array.isArray(sx) ? sx : [sx]),
  ];
  const content = (
    <>
      {error ? (
        <Alert severity="error" role="alert">
          {error}
        </Alert>
      ) : null}
      {children}
    </>
  );
  // A div has no native submit behavior, including requestSubmit() from autofill.
  // Keep form-only props on the branch with actual form semantics.
  return component === 'form' ? (
    <Box component="form" noValidate onSubmit={onSubmit} id={id} sx={containerSx}>
      {content}
    </Box>
  ) : (
    <Box component="div" id={id} sx={containerSx}>
      {content}
    </Box>
  );
}

/**
 * Focus (and centre-scroll) the first control the browser marked invalid.
 *
 * The kit's convention is that the caller validates on submit and flags each bad field
 * with `error` (which MUI maps to `aria-invalid="true"` on the input). After a failed
 * submit, call this with the form element to send keyboard focus to the first offender.
 *
 * Returns the focused element, or `null` if nothing was invalid.
 */
export function focusFirstInvalid(formEl: HTMLElement | null | undefined): HTMLElement | null {
  if (!formEl) return null;
  const invalid = formEl.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!invalid) return null;
  invalid.focus();
  if (typeof invalid.scrollIntoView === 'function') {
    invalid.scrollIntoView({ block: 'center' });
  }
  return invalid;
}

/**
 * Schedule `focusFirstInvalid` for after React commits the failed-validation render.
 *
 * Call this from a submit handler's early-return branch, passing the FormShell's `id`.
 * The deferral matters: inside the handler the fields haven't re-rendered with
 * `aria-invalid="true"` yet, so a synchronous call would find nothing.
 *
 * Constraint: one rAF is enough only when the error-state update commits before the
 * next paint (true for plain setState in a submit handler). If a caller ever sets the
 * error state inside `startTransition`, the callback can fire before `aria-invalid`
 * lands — don't wrap validation errors in a transition.
 */
export function focusFirstInvalidAfterRender(formId: string): void {
  if (typeof window === 'undefined') return;
  requestAnimationFrame(() => focusFirstInvalid(document.getElementById(formId)));
}
