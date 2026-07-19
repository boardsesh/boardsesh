const unavailable = () => Promise.reject(new Error('Native Google sign-in is not available in the Expo web app'));

export const statusCodes = {
  SIGN_IN_CANCELLED: 'SIGN_IN_CANCELLED',
  IN_PROGRESS: 'IN_PROGRESS',
  PLAY_SERVICES_NOT_AVAILABLE: 'PLAY_SERVICES_NOT_AVAILABLE',
} as const;

export const GoogleSignin = {
  configure: () => {},
  hasPlayServices: () => Promise.resolve(false),
  signIn: unavailable,
  signOut: () => Promise.resolve(),
  revokeAccess: () => Promise.resolve(),
  getTokens: unavailable,
};

function GoogleSigninButtonBase(): null {
  return null;
}

export const GoogleSigninButton = Object.assign(GoogleSigninButtonBase, {
  Size: { Icon: 0, Standard: 1, Wide: 2 },
  Color: { Dark: 0, Light: 1 },
});

export function isErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}
