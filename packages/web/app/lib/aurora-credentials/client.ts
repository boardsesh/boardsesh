import { getBackendHttpUrl } from '@/app/lib/backend-url';
import type { AuroraBoardName } from '@boardsesh/shared-schema';

export type AuroraCredentialStatus = {
  boardType: string;
  auroraUsername: string;
  auroraUserId: number | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  createdAt: string;
};

export type AuroraCredentialsResponse = {
  credentials: AuroraCredentialStatus[];
};

export type DeleteCredentialResult =
  | { success: true }
  | { success: false; localCleared: true; reason: 'revocation_failed' };

export type AuroraBackendTransport = {
  backendUrl: string;
  authToken: string;
};

export class AuroraBackendError extends Error {
  readonly status: number;
  // Stable machine code from the backend (e.g. 'account_already_linked') for
  // callers to localise off, independent of the plain-English `message`.
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'AuroraBackendError';
    this.status = status;
    if (code) this.code = code;
  }
}

export function resolveAuroraBackendTransport(authToken: string | null | undefined): AuroraBackendTransport | null {
  const backendUrl = getBackendHttpUrl();
  if (!backendUrl || !authToken) return null;
  return { backendUrl, authToken };
}

function endpoint(transport: AuroraBackendTransport, path: string): string {
  return `${transport.backendUrl.replace(/\/+$/, '')}${path}`;
}

function buildRequestHeaders(headers: RequestInit['headers'], authToken: string, hasJsonBody: boolean): Headers {
  const mergedHeaders = new Headers(headers);
  mergedHeaders.set('Authorization', `Bearer ${authToken}`);
  if (hasJsonBody) {
    mergedHeaders.set('Content-Type', 'application/json');
  }
  return mergedHeaders;
}

async function readError(response: Response, fallback: string): Promise<{ message: string; code?: string }> {
  try {
    const payload = (await response.json()) as { error?: string; code?: string };
    return { message: payload.error ?? fallback, code: payload.code };
  } catch {
    return { message: fallback };
  }
}

async function requestBackendJson<T>(
  transport: AuroraBackendTransport,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(endpoint(transport, path), {
    ...init,
    headers: buildRequestHeaders(init.headers, transport.authToken, Boolean(init.body)),
  });

  if (!response.ok) {
    const { message, code } = await readError(response, 'Request failed');
    throw new AuroraBackendError(response.status, message, code);
  }

  return (await response.json()) as T;
}

export async function getAuroraCredentials(transport: AuroraBackendTransport): Promise<AuroraCredentialsResponse> {
  return requestBackendJson<AuroraCredentialsResponse>(transport, '/api/aurora-credentials');
}

export async function saveAuroraCredential(
  transport: AuroraBackendTransport,
  input: { boardType: AuroraBoardName; username: string; password: string },
): Promise<AuroraCredentialStatus> {
  const response = await requestBackendJson<{ credential: AuroraCredentialStatus }>(
    transport,
    '/api/aurora-credentials',
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
  return response.credential;
}

export async function deleteAuroraCredential(
  transport: AuroraBackendTransport,
  boardType: AuroraBoardName,
): Promise<DeleteCredentialResult> {
  return requestBackendJson<DeleteCredentialResult>(transport, '/api/aurora-credentials', {
    method: 'DELETE',
    body: JSON.stringify({ boardType }),
  });
}

export async function createKilterHandoffStartUrl(
  transport: AuroraBackendTransport,
  returnUrl: string,
): Promise<string> {
  const response = await requestBackendJson<{ startUrl: string }>(transport, '/api/board-credentials/kilter/handoff', {
    method: 'POST',
    body: JSON.stringify({ returnUrl }),
  });
  return response.startUrl;
}
