export const API_ORIGIN = 'https://api.boardsesh.com';
/** Public/native app identity, shared by installations; never a client secret. */
export const PUBLIC_CLIENT_ID = 'IsrNoYVHWCQaBEREJawWEDMrNTXMdzQq';
/** Keep historical defaults here when replacing PUBLIC_CLIENT_ID: old profiles had no provenance. */
export const LEGACY_PUBLIC_CLIENT_IDS: readonly string[] = ['IsrNoYVHWCQaBEREJawWEDMrNTXMdzQq'];
export const ISSUER = `${API_ORIGIN}/api/auth`;
export const RESOURCE = `${API_ORIGIN}/v1`;
export const SCOPES = ['logbook:read', 'workouts:read', 'workouts:write', 'offline_access'];

export interface Profile {
  issuer: string;
  clientId: string;
  /** Missing on profiles written before client selection provenance was stored. */
  clientIdSource?: 'bundled' | 'override';
  subject: string;
  accountId: string;
  generation: string;
  authStatus: 'connected' | 'reconnect_required' | 'logged_out';
  scopes: string[];
}

export interface ProfileStore {
  getProfile(): Profile | undefined;
  setProfile(profile: Profile): void;
  activateProfile(profile: Profile): void;
  assertProfile(generation: string): Profile;
  resetSync(profile: Profile): void;
}

/** Network methods are called while holding the shared profile lock. */
export interface PartnerClient {
  request(
    profile: Profile,
    path: string,
    options?: { method?: string; body?: unknown; idempotencyKey?: string },
  ): Promise<unknown>;
}

export class McpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class PartnerError extends McpError {
  constructor(
    readonly status: number,
    code: string,
    message: string,
    retryAfterSeconds?: number,
  ) {
    super(code, message, retryAfterSeconds);
  }
}
