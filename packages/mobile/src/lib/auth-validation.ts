// Pure, framework-free auth field validation shared by the mobile login and
// register screens so the two can't drift. Each validator returns the i18n KEY
// of the first failing rule per field (or leaves the field undefined), which the
// screen passes to its `t('auth')` translator. Rules mirror the web validator
// (packages/web/app/components/auth/validate-fields.ts) and the backend
// /auth/native/register bounds, so the client never blocks an input the server
// would accept, nor submits one the server will reject.

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const NAME_MAX_LENGTH = 100;

export type LoginFieldErrors = { email?: string; password?: string };
export type RegisterFieldErrors = {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
};

export function validateLoginFields(values: { email: string; password: string }): LoginFieldErrors {
  const errors: LoginFieldErrors = {};
  const email = values.email.trim();
  if (!email) {
    errors.email = 'login.validation.emailRequired';
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = 'login.validation.emailInvalid';
  }
  if (!values.password) {
    errors.password = 'login.validation.passwordRequired';
  }
  return errors;
}

export function validateRegisterFields(values: {
  name?: string;
  email: string;
  password: string;
  confirmPassword: string;
}): RegisterFieldErrors {
  const errors: RegisterFieldErrors = {};
  const email = values.email.trim();
  const name = values.name?.trim() ?? '';

  if (name.length > NAME_MAX_LENGTH) {
    errors.name = 'login.validation.nameTooLong';
  }
  if (!email) {
    errors.email = 'login.validation.emailRequired';
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = 'login.validation.emailInvalid';
  }
  if (!values.password) {
    errors.password = 'login.validation.passwordRequiredCreate';
  } else if (values.password.length < PASSWORD_MIN_LENGTH) {
    errors.password = 'login.validation.passwordTooShort';
  } else if (values.password.length > PASSWORD_MAX_LENGTH) {
    errors.password = 'login.validation.passwordTooLong';
  }
  if (!values.confirmPassword) {
    errors.confirmPassword = 'login.validation.confirmPasswordRequired';
  } else if (values.confirmPassword !== values.password) {
    errors.confirmPassword = 'login.validation.passwordsMismatch';
  }
  return errors;
}

/** True when no field has an error. */
export function isValid(errors: LoginFieldErrors | RegisterFieldErrors): boolean {
  return Object.keys(errors).length === 0;
}
