import type { TFunction } from 'i18next';

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const initialLoginValues = { email: '', password: '' };
export const initialRegisterValues = { name: '', email: '', password: '', confirmPassword: '' };

export type LoginValues = typeof initialLoginValues;
export type RegisterValues = typeof initialRegisterValues;
export type LoginErrors = Partial<Record<keyof LoginValues, string>>;
export type RegisterErrors = Partial<Record<keyof RegisterValues, string>>;

export function validateLoginFields(values: LoginValues, t: TFunction<'auth'>): LoginErrors {
  const errors: LoginErrors = {};
  if (!values.email) {
    errors.email = t('login.validation.emailRequired');
  } else if (!EMAIL_REGEX.test(values.email)) {
    errors.email = t('login.validation.emailInvalid');
  }
  if (!values.password) {
    errors.password = t('login.validation.passwordRequired');
  }
  return errors;
}

export function validateRegisterFields(values: RegisterValues, t: TFunction<'auth'>): RegisterErrors {
  const errors: RegisterErrors = {};
  if (values.name && values.name.length > 100) {
    errors.name = t('login.validation.nameTooLong');
  }
  if (!values.email) {
    errors.email = t('login.validation.emailRequired');
  } else if (!EMAIL_REGEX.test(values.email)) {
    errors.email = t('login.validation.emailInvalid');
  }
  if (!values.password) {
    errors.password = t('login.validation.passwordRequiredCreate');
  } else if (values.password.length < 8) {
    errors.password = t('login.validation.passwordTooShort');
  }
  if (!values.confirmPassword) {
    errors.confirmPassword = t('login.validation.confirmPasswordRequired');
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = t('login.validation.passwordsMismatch');
  }
  return errors;
}
