import 'server-only';
import { randomUUID } from 'node:crypto';
import {
  GUESS_LIMIT_PATHS,
  GUESS_LIMIT_REQUEST_BYTES,
  GUESS_LIMIT_VERSION,
  GUESS_LIMIT_WEB_TIMEOUT_MS,
  guessDoneReplySchema,
  guessReserveReplySchema,
  type GuessReserveReply,
} from '@boardsesh/auth-protocol';
import { readDeviceTokenSecret, verifyDeviceToken } from '@boardsesh/auth-protocol/device-token';
import { createAuthCommandTransport, type AuthServiceEnvironment } from './auth-command-transport.server';
import { deviceTokenCookieName } from './device-token-cookie';

/** NextAuth turns thrown authorize errors into redirects; the route preserves this as its usual 429. */
export class PasswordGuessRefusedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Password guess limit reached');
  }
}

let lastWarningAt = Number.NEGATIVE_INFINITY;
function reportUnavailable(): void {
  const now = Date.now();
  if (now - lastWarningAt < 60_000) return;
  lastWarningAt = now;
  // No submitted address, credential, token or backend error reaches telemetry.
  console.warn(JSON.stringify({ event: 'auth_password_guess_limit_unavailable' }));
}

/** A duplicate or malformed cookie proves no device; never pick the first copy. */
export function readRequestDeviceToken(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== 'string') return undefined;
  const name = deviceTokenCookieName();
  const matches = cookieHeader.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    return separator >= 0 && part.slice(0, separator).trim() === name ? [part.slice(separator + 1).trim()] : [];
  });
  const token = matches.length === 1 ? matches[0] : undefined;
  return token && token.length <= 128 && /^[A-Za-z0-9._-]+$/.test(token) ? token : undefined;
}

export function createWebGuessLimitClient(
  options: {
    environment?: AuthServiceEnvironment;
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {},
) {
  const environment = options.environment ?? process.env;
  const mode = environment.AUTH_ACCOUNT_GUESS_LIMIT_MODE;
  if (mode === undefined || mode === '' || mode === 'off') return null;
  // The backend owns mode validation and all enforcement gates. Unknown web
  // configuration cannot turn a failed auxiliary counter into a login outage.
  if (mode !== 'observe' && mode !== 'enforce') {
    reportUnavailable();
    return null;
  }
  try {
    const transport = createAuthCommandTransport({
      ...options,
      environment,
      paths: Object.values(GUESS_LIMIT_PATHS),
      timeoutMs: options.timeoutMs ?? GUESS_LIMIT_WEB_TIMEOUT_MS,
      requestBytes: GUESS_LIMIT_REQUEST_BYTES,
      responseBytes: GUESS_LIMIT_REQUEST_BYTES,
    });
    const metadata = () => ({ version: GUESS_LIMIT_VERSION, requestId: randomUUID(), issuedAt: Date.now() });
    return {
      async reserve(email: string, deviceToken?: string, candidateUserId?: string): Promise<GuessReserveReply | null> {
        try {
          const response = await transport.post(GUESS_LIMIT_PATHS.reserve, {
            ...metadata(),
            operation: 'reserve',
            email,
            ...(deviceToken ? { deviceToken } : {}),
            ...(candidateUserId ? { candidateUserId } : {}),
          });
          if (response.status !== 200) throw new Error('Counter unavailable');
          return guessReserveReplySchema.parse(response.body);
        } catch {
          reportUnavailable();
          return null;
        }
      },
      async settle(
        email: string,
        admission: GuessReserveReply | null,
        verdict: 'accepted' | 'no_verdict',
      ): Promise<void> {
        if (admission?.outcome !== 'proceed' || (!admission.reservation && !admission.wouldRefuse)) return;
        try {
          const response = await transport.post(GUESS_LIMIT_PATHS['give-back'], {
            ...metadata(),
            operation: 'give-back',
            email,
            verdict,
            ...(admission.reservation ? { reservation: admission.reservation } : {}),
            ...(admission.wouldRefuse ? { wouldRefuse: true } : {}),
          });
          if (response.status !== 200) throw new Error('Counter unavailable');
          guessDoneReplySchema.parse(response.body);
        } catch {
          reportUnavailable();
        }
      },
      async clear(email: string): Promise<void> {
        try {
          const response = await transport.post(GUESS_LIMIT_PATHS.clear, { ...metadata(), operation: 'clear', email });
          if (response.status !== 200) throw new Error('Counter unavailable');
          guessDoneReplySchema.parse(response.body);
        } catch {
          reportUnavailable();
        }
      },
    };
  } catch {
    reportUnavailable();
    return null;
  }
}

/** Called after the existing email lookup, before any legacy bcrypt compare. */
export async function admitLegacyWebPasswordGuess(input: {
  email: string;
  accounts: readonly { id: string }[];
  cookieHeader: unknown;
}) {
  const client = createWebGuessLimitClient();
  if (!client) return { settle: async (_verdict: 'accepted' | 'rejected' | 'no_verdict') => {} };
  const token = readRequestDeviceToken(input.cookieHeader);
  let deviceToken: string | undefined;
  let candidateUserId: string | undefined;
  const secret = readDeviceTokenSecret(process.env);
  if (token && 'secret' in secret) {
    for (const account of input.accounts) {
      if (await verifyDeviceToken(token, { userId: account.id, secret: secret.secret })) {
        deviceToken = token;
        candidateUserId = account.id;
        break;
      }
    }
  }
  const admission = await client.reserve(input.email, deviceToken, candidateUserId);
  if (admission?.outcome === 'refused') throw new PasswordGuessRefusedError(admission.retryAfterSeconds);
  let settled = false;
  return {
    async settle(verdict: 'accepted' | 'rejected' | 'no_verdict') {
      if (settled) return;
      settled = true;
      if (verdict !== 'rejected') await client.settle(input.email, admission, verdict);
    },
  };
}
