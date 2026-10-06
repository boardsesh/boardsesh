// `provider` on the login events (#6027).
//
// Every login event already carries `auth_method`, whose email value is the
// internal name `credentials`. `provider` is the same fact under the name an
// analyst looks for, with the email value spelled `email`. It exists so "which
// sign-in do mainland-China climbers rely on, and is it Google that fails
// there" is one breakdown instead of a lookup of what `credentials` means.
// `auth_method` stays, unchanged, for every saved insight that reads it.

export type LoginAuthMethod = 'credentials' | 'google' | 'apple';

export type LoginProvider = 'email' | 'google' | 'apple';

export type LoginProviderProperties<TMethod extends LoginAuthMethod = LoginAuthMethod> = {
  auth_method: TMethod;
  provider: LoginProvider;
};

const PROVIDER_BY_AUTH_METHOD: Record<LoginAuthMethod, LoginProvider> = {
  credentials: 'email',
  google: 'google',
  apple: 'apple',
};

/**
 * The two sign-in props every login event carries, built together so a call
 * site cannot send one without the other or let them disagree.
 */
export function loginProviderProperties<TMethod extends LoginAuthMethod>(
  authMethod: TMethod,
): LoginProviderProperties<TMethod> {
  return { auth_method: authMethod, provider: PROVIDER_BY_AUTH_METHOD[authMethod] };
}
