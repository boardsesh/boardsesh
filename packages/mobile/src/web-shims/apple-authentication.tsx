export const AppleAuthenticationButtonType = {
  SIGN_IN: 0,
  CONTINUE: 1,
  SIGN_UP: 2,
} as const;

export const AppleAuthenticationButtonStyle = {
  WHITE: 0,
  WHITE_OUTLINE: 1,
  BLACK: 2,
} as const;

export const AppleAuthenticationScope = {
  FULL_NAME: 0,
  EMAIL: 1,
} as const;

export function AppleAuthenticationButton(): null {
  return null;
}

export function isAvailableAsync(): Promise<boolean> {
  return Promise.resolve(false);
}

export function signInAsync(): Promise<never> {
  return Promise.reject(new Error('Apple authentication is not available in the Expo web app'));
}

export function refreshAsync(): Promise<never> {
  return Promise.reject(new Error('Apple authentication is not available in the Expo web app'));
}

export function signOutAsync(): Promise<void> {
  return Promise.resolve();
}
