import { describe, it, expect } from 'vitest';
import {
  EMAIL_REGEX,
  PASSWORD_MIN_LENGTH,
  PASSWORD_MAX_LENGTH,
  NAME_MAX_LENGTH,
  validateLoginFields,
  validateRegisterFields,
  isValid,
} from '../auth-validation';

// A valid base for register cases — override one field per test so each
// assertion isolates a single rule.
function register(overrides: Partial<{ name: string; email: string; password: string; confirmPassword: string }> = {}) {
  return validateRegisterFields({
    name: '',
    email: 'climber@example.com',
    password: 'longenough',
    confirmPassword: 'longenough',
    ...overrides,
  });
}

describe('EMAIL_REGEX', () => {
  it.each(['a@b.co', 'first.last@sub.domain.io', 'x+tag@y.dev'])('accepts %s', (email) => {
    expect(EMAIL_REGEX.test(email)).toBe(true);
  });

  it.each(['', 'no-at', 'no@dot', 'a@b.', '@b.co', 'a b@c.co', 'a@b c.co'])('rejects %s', (email) => {
    expect(EMAIL_REGEX.test(email)).toBe(false);
  });
});

describe('validateLoginFields', () => {
  it('passes for a valid email + password', () => {
    const errors = validateLoginFields({ email: 'a@b.co', password: 'pw' });
    expect(isValid(errors)).toBe(true);
  });

  it('requires the email', () => {
    expect(validateLoginFields({ email: '', password: 'pw' }).email).toBe('login.validation.emailRequired');
  });

  it('rejects a malformed email', () => {
    expect(validateLoginFields({ email: 'nope', password: 'pw' }).email).toBe('login.validation.emailInvalid');
  });

  it('requires the password', () => {
    expect(validateLoginFields({ email: 'a@b.co', password: '' }).password).toBe('login.validation.passwordRequired');
  });

  it('trims surrounding whitespace before validating the email', () => {
    expect(isValid(validateLoginFields({ email: '  a@b.co  ', password: 'pw' }))).toBe(true);
  });
});

describe('validateRegisterFields', () => {
  it('passes when every field is valid (name optional)', () => {
    expect(isValid(register())).toBe(true);
  });

  it('requires the email and rejects a malformed one', () => {
    expect(register({ email: '' }).email).toBe('login.validation.emailRequired');
    expect(register({ email: 'bad' }).email).toBe('login.validation.emailInvalid');
  });

  it('requires a password and enforces the min length', () => {
    expect(register({ password: '', confirmPassword: '' }).password).toBe('login.validation.passwordRequiredCreate');
    const tooShort = 'a'.repeat(PASSWORD_MIN_LENGTH - 1);
    expect(register({ password: tooShort, confirmPassword: tooShort }).password).toBe(
      'login.validation.passwordTooShort',
    );
  });

  it('enforces the max length (matches the backend 128-char bound)', () => {
    const atMax = 'a'.repeat(PASSWORD_MAX_LENGTH);
    expect(register({ password: atMax, confirmPassword: atMax }).password).toBeUndefined();
    const tooLong = 'a'.repeat(PASSWORD_MAX_LENGTH + 1);
    expect(register({ password: tooLong, confirmPassword: tooLong }).password).toBe('login.validation.passwordTooLong');
  });

  it('accepts the exact min length', () => {
    const atMin = 'a'.repeat(PASSWORD_MIN_LENGTH);
    expect(register({ password: atMin, confirmPassword: atMin }).password).toBeUndefined();
  });

  it('requires confirmation and flags a mismatch', () => {
    expect(register({ confirmPassword: '' }).confirmPassword).toBe('login.validation.confirmPasswordRequired');
    expect(register({ password: 'longenough', confirmPassword: 'different1' }).confirmPassword).toBe(
      'login.validation.passwordsMismatch',
    );
  });

  it('allows a name up to the boundary and flags one past it', () => {
    expect(register({ name: 'a'.repeat(NAME_MAX_LENGTH) }).name).toBeUndefined();
    expect(register({ name: 'a'.repeat(NAME_MAX_LENGTH + 1) }).name).toBe('login.validation.nameTooLong');
  });

  it('trims a name before measuring it (whitespace-padded max passes)', () => {
    expect(register({ name: `  ${'a'.repeat(NAME_MAX_LENGTH)}  ` }).name).toBeUndefined();
  });
});

describe('isValid', () => {
  it('is true for no errors and false when any field has an error', () => {
    expect(isValid({})).toBe(true);
    expect(isValid({ email: 'login.validation.emailRequired' })).toBe(false);
  });
});
