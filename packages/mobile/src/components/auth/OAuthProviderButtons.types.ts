export type OAuthProvider = 'apple' | 'google';

export type OAuthProviderAvailability = {
  apple: boolean;
  google: boolean;
  loading: boolean;
  error: boolean;
  retry: () => void;
};

export type OAuthProviderButtonsProps = {
  disabled: boolean;
  isRegistration: boolean;
  onSignIn: (provider: OAuthProvider) => void;
  providers: OAuthProviderAvailability;
};
