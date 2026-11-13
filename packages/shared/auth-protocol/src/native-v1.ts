/**
 * Released native/watch wire vocabulary. Additive metadata is optional for old
 * backends. These types do not replace recorded client execution or validate a
 * credential, and no application adopts this module in N1.
 */
export const NATIVE_V1_PATHS = {
  credentials: '/auth/native/credentials',
  register: '/auth/native/register',
  oauth: '/auth/native/oauth',
  exchange: '/auth/native/exchange',
  refresh: '/auth/native/refresh',
  revoke: '/auth/native/revoke',
  watchPairCode: '/api/watch/pair-code',
  watchPair: '/api/watch/pair',
  browserStart: '/auth/native-start',
  forgotPassword: '/api/auth/forgot-password',
  resetPassword: '/api/auth/reset-password',
} as const;

export interface NativeV1AccountCreationReceipt {
  readonly userId: string;
  readonly accountCreated: boolean;
  readonly provider: 'email' | 'apple' | 'google';
  readonly createdAt: string;
}

export interface NativeV1TokenReply {
  readonly jwt: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly userId?: string;
  readonly accountCreation?: NativeV1AccountCreationReceipt;
}

export interface NativeV1ErrorReply {
  readonly error: string;
}

export interface NativeV1CredentialsRequest {
  readonly email: string;
  readonly password: string;
}

export interface NativeV1RegistrationRequest extends NativeV1CredentialsRequest {
  readonly name?: string;
}

export interface NativeV1OAuthRequest {
  readonly provider: 'apple' | 'google';
  readonly identityToken: string;
  readonly nonce?: string;
  readonly name?: { readonly firstName?: string; readonly lastName?: string };
}

export interface NativeV1ExchangeRequest {
  readonly transferToken: string;
}

export interface NativeV1RefreshRequest {
  readonly refreshToken: string;
}

export type NativeV1RevokeRequest = NativeV1RefreshRequest;

export interface NativeV1WatchPairRequest {
  readonly code: string;
}

export interface NativeV1WatchPairCodeReply {
  readonly code: string;
  readonly expiresAt: string;
}

export interface NativeV1PasswordResetRequest {
  readonly email: string;
  readonly token: string;
  readonly password: string;
  readonly confirmPassword: string;
}
