import type {
  CreateOAuthClientInput,
  OAuthClient,
  OAuthClientApplicationType,
  OAuthClientAuthMethod,
  UpdateOAuthClientInput,
} from '@boardsesh/shared-schema';

/**
 * The developer console's register and edit form, as plain data. The backend
 * (`auth/partner/registration-rules.ts`) is the authority on every rule; this
 * only shapes what the form holds into what the GraphQL operations take, so the
 * page never invents a rule the server does not have.
 */

export type AppClientType = 'confidential' | 'public';
export type AppSecretMethod = Extract<OAuthClientAuthMethod, 'CLIENT_SECRET_BASIC' | 'CLIENT_SECRET_POST'>;

export type AppFormState = {
  name: string;
  publisherName: string;
  homepageUrl: string;
  privacyPolicyUrl: string;
  applicationType: OAuthClientApplicationType;
  clientType: AppClientType;
  secretMethod: AppSecretMethod;
  /** One redirect URI per line, as typed. */
  redirectUris: string;
};

export type AppFormField = 'name' | 'publisherName' | 'privacyPolicyUrl' | 'redirectUris';

/** The backend's own cap (`PARTNER_REDIRECT_URIS_PER_APP`). */
export const MAX_REDIRECT_URIS = 10;

export const EMPTY_APP_FORM: AppFormState = {
  name: '',
  publisherName: '',
  homepageUrl: '',
  privacyPolicyUrl: '',
  applicationType: 'WEB',
  clientType: 'confidential',
  secretMethod: 'CLIENT_SECRET_BASIC',
  redirectUris: '',
};

/** Lines with something on them, trimmed. Order is kept; the server refuses repeats. */
export function parseRedirectUris(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function authMethodFor(state: Pick<AppFormState, 'clientType' | 'secretMethod'>): OAuthClientAuthMethod {
  return state.clientType === 'public' ? 'NONE' : state.secretMethod;
}

/** Fields the form must not send empty. Everything else the server checks, with its own message. */
export function missingAppFormFields(state: AppFormState): AppFormField[] {
  const missing: AppFormField[] = [];
  if (state.name.trim().length === 0) missing.push('name');
  if (state.publisherName.trim().length === 0) missing.push('publisherName');
  if (state.privacyPolicyUrl.trim().length === 0) missing.push('privacyPolicyUrl');
  if (parseRedirectUris(state.redirectUris).length === 0) missing.push('redirectUris');
  return missing;
}

export function toCreateInput(state: AppFormState): CreateOAuthClientInput {
  const homepageUrl = state.homepageUrl.trim();
  return {
    name: state.name.trim(),
    publisherName: state.publisherName.trim(),
    ...(homepageUrl ? { homepageUrl } : {}),
    privacyPolicyUrl: state.privacyPolicyUrl.trim(),
    applicationType: state.applicationType,
    tokenEndpointAuthMethod: authMethodFor(state),
    redirectUris: parseRedirectUris(state.redirectUris),
  };
}

export function formFromApp(app: OAuthClient): AppFormState {
  return {
    name: app.name,
    publisherName: app.publisherName ?? '',
    homepageUrl: app.homepageUrl ?? '',
    privacyPolicyUrl: app.privacyPolicyUrl,
    applicationType: app.applicationType,
    clientType: app.tokenEndpointAuthMethod === 'NONE' ? 'public' : 'confidential',
    secretMethod: app.tokenEndpointAuthMethod === 'CLIENT_SECRET_POST' ? 'CLIENT_SECRET_POST' : 'CLIENT_SECRET_BASIC',
    redirectUris: app.redirectUris.join('\n'),
  };
}

/**
 * Only what changed: the server treats a field left out as "keep it". A cleared
 * homepage is sent as null, which removes it. The app type and the client type
 * never change after registration, so they are never sent.
 */
export function toUpdateInput(app: OAuthClient, state: AppFormState): UpdateOAuthClientInput {
  const input: UpdateOAuthClientInput = { clientId: app.clientId };
  const name = state.name.trim();
  if (name !== app.name) input.name = name;
  const publisherName = state.publisherName.trim();
  if (publisherName !== (app.publisherName ?? '')) input.publisherName = publisherName;
  const homepageUrl = state.homepageUrl.trim();
  if (homepageUrl !== (app.homepageUrl ?? '')) input.homepageUrl = homepageUrl || null;
  const privacyPolicyUrl = state.privacyPolicyUrl.trim();
  if (privacyPolicyUrl !== app.privacyPolicyUrl) input.privacyPolicyUrl = privacyPolicyUrl;
  const redirectUris = parseRedirectUris(state.redirectUris);
  if (redirectUris.join('\n') !== app.redirectUris.join('\n')) input.redirectUris = redirectUris;
  return input;
}

/** True when an edit would send nothing but the client ID. */
export function isEmptyUpdate(input: UpdateOAuthClientInput): boolean {
  return Object.keys(input).length === 1;
}
