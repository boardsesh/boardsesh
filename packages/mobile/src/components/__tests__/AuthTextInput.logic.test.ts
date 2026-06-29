import { describe, expect, it } from 'vitest';
import {
  computeMasked,
  shouldPushValueToNative,
  toAndroidContentType,
  toAndroidKeyboardOptions,
  toIosAutocapitalization,
  toIosKeyboardType,
  toIosSubmitLabel,
  toIosTextContentType,
} from '../AuthTextInput.logic';

describe('shouldPushValueToNative', () => {
  it('is false when the value echoes what we last emitted (normal typing)', () => {
    expect(shouldPushValueToNative('abc', 'abc')).toBe(false);
  });

  it('is true when the value changes externally (e.g. EditProfile seed / reset)', () => {
    expect(shouldPushValueToNative('seeded@example.com', '')).toBe(true);
  });
});

describe('computeMasked', () => {
  it('masks a secure field until revealed', () => {
    expect(computeMasked(true, false)).toBe(true);
    expect(computeMasked(true, true)).toBe(false);
  });

  it('never masks a non-secure field', () => {
    expect(computeMasked(false, false)).toBe(false);
    expect(computeMasked(false, true)).toBe(false);
  });
});

describe('toIosKeyboardType', () => {
  it('maps the values the auth screens use', () => {
    expect(toIosKeyboardType('email-address')).toBe('email-address');
    expect(toIosKeyboardType('number-pad')).toBe('numeric');
    expect(toIosKeyboardType('url')).toBe('url');
  });

  it('returns undefined for an unmapped / absent type', () => {
    expect(toIosKeyboardType(undefined)).toBeUndefined();
    expect(toIosKeyboardType('visible-password')).toBeUndefined();
  });
});

describe('toIosAutocapitalization', () => {
  it("maps RN 'none' to SwiftUI 'never' and passes the rest through", () => {
    expect(toIosAutocapitalization('none')).toBe('never');
    expect(toIosAutocapitalization('words')).toBe('words');
    expect(toIosAutocapitalization('sentences')).toBe('sentences');
    expect(toIosAutocapitalization('characters')).toBe('characters');
    expect(toIosAutocapitalization(undefined)).toBeUndefined();
  });
});

describe('toIosTextContentType', () => {
  it('maps the autofill content types the auth screens use', () => {
    expect(toIosTextContentType('emailAddress')).toBe('emailAddress');
    expect(toIosTextContentType('newPassword')).toBe('newPassword');
    expect(toIosTextContentType('username')).toBe('username');
    expect(toIosTextContentType('name')).toBe('name');
  });

  it('returns undefined for an unsupported / absent content type', () => {
    expect(toIosTextContentType(undefined)).toBeUndefined();
    expect(toIosTextContentType('addressCity')).toBeUndefined();
  });
});

describe('toIosSubmitLabel', () => {
  it('maps the return keys the auth screens use', () => {
    expect(toIosSubmitLabel('next')).toBe('next');
    expect(toIosSubmitLabel('done')).toBe('done');
    expect(toIosSubmitLabel(undefined)).toBeUndefined();
  });
});

describe('toAndroidKeyboardOptions', () => {
  it('maps an email field', () => {
    expect(
      toAndroidKeyboardOptions({
        keyboardType: 'email-address',
        autoCapitalize: 'none',
        autoCorrect: false,
        returnKeyType: 'next',
        secureTextEntry: false,
      }),
    ).toEqual({
      capitalization: 'none',
      autoCorrectEnabled: false,
      keyboardType: 'email',
      imeAction: 'next',
    });
  });

  it('forces the password IME + no autocorrect for a secure field without an explicit keyboard', () => {
    expect(
      toAndroidKeyboardOptions({
        keyboardType: undefined,
        autoCapitalize: 'none',
        autoCorrect: false,
        returnKeyType: 'done',
        secureTextEntry: true,
      }),
    ).toEqual({
      capitalization: 'none',
      autoCorrectEnabled: false,
      keyboardType: 'password',
      imeAction: 'done',
    });
  });

  it("maps the name field's word capitalization with the default IME action", () => {
    expect(
      toAndroidKeyboardOptions({
        keyboardType: undefined,
        autoCapitalize: 'words',
        autoCorrect: false,
        returnKeyType: undefined,
        secureTextEntry: false,
      }),
    ).toEqual({
      capitalization: 'words',
      autoCorrectEnabled: false,
      keyboardType: undefined,
      imeAction: 'default',
    });
  });
});

describe('toAndroidContentType', () => {
  it('passes the RN autoComplete token straight through (matches the Compose ContentType mapper)', () => {
    expect(toAndroidContentType('email')).toBe('email');
    expect(toAndroidContentType('password')).toBe('password');
    expect(toAndroidContentType('new-password')).toBe('new-password');
    expect(toAndroidContentType('name')).toBe('name');
  });

  it('is undefined when no autoComplete is given', () => {
    expect(toAndroidContentType(undefined)).toBeUndefined();
  });
});
