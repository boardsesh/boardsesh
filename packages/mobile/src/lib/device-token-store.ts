// SecureStore side of the device tokens from #7656 (rules in
// device-token-ledger.ts). Native only: device-token-store.web.ts is the browser
// target's fork, which stores nothing and never names the request header — the
// backend's CORS does not allow it, so a browser that sent it would fail the
// preflight and could not sign in. The browser signs in through www, where an
// HttpOnly cookie does this job.
//
// One SecureStore key holds every account's token as a small JSON ledger
// (at most MAX_DEVICE_TOKEN_ACCOUNTS entries). It goes through secure-store-io
// like every other key, so it follows docs/auth/keychain-namespaces.md: v2 first on
// read, written to v2 with a best-effort legacy mirror and a freshness stamp,
// deleted from both namespaces with a read-back and a tombstone. It is not in
// PREFERENCE_SECURE_KEYS: no build before this one ever wrote it, so there is
// no legacy-only copy to migrate, and a rolled-back build never touches it, so
// the stamp can never see it diverge.
//
// The ledger outlives sign-out on purpose: a signed-out phone is still a
// recognised device. Only deleting the account on this device removes its entry.
//
// Nothing here throws to a caller and nothing logs a token. Every failure means
// "no token": a sign-in proceeds exactly as it did before this module existed.

import { deleteSecureValue, readSecureValue, writeSecureValue } from './secure-store-io';
import {
  chooseDeviceTokenForEmail,
  forgetDeviceTokenAccount,
  mergeDeviceTokenReply,
  usableDeviceTokenEmail,
  parseDeviceTokenLedger,
  readDeviceTokenFromReply,
  serializeDeviceTokenLedger,
  setDeviceTokenAccountEmail,
  type DeviceTokenLedger,
} from './device-token-ledger';
import { userIdFromJwt } from './jwt-user-id';

export const DEVICE_TOKEN_LEDGER_KEY = 'boardsesh_device_tokens';

/**
 * The request header that returns a stored token (`NATIVE_V1_DEVICE_TOKEN_HEADER`
 * in @boardsesh/auth-protocol, which mobile does not depend on; a test pins the
 * two together). Sent on `/auth/native/credentials` only.
 */
export const NATIVE_DEVICE_TOKEN_HEADER = 'x-boardsesh-device-token';

/**
 * How long a password sign-in waits for the keychain before giving up and
 * sending no header. Every Expo AsyncFunction shares one serial native queue,
 * so a slow call elsewhere must not hold the sign-in button.
 */
const HEADER_READ_DEADLINE_MS = 1_000;

export type DeviceTokenStorage = {
  read: (key: string) => Promise<string | null>;
  write: (key: string, value: string) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

export type DeviceTokenStore = {
  /** Store the token a sign-in, registration, OAuth, exchange or refresh reply carried. Never throws. */
  rememberFromReply: (reply: unknown, options?: { email?: string; jwt?: string }) => Promise<void>;
  /** The header to send on a password sign-in for `email`: empty when no token matches. Never throws. */
  headersForCredentialsSignIn: (email: string) => Promise<Record<string, string>>;
  /**
   * Record `email` as the account email of `userId` on its stored entry, when
   * it has one. Fed by the signed-in profile, so accounts whose tokens only ever
   * came from refresh, OAuth or exchange replies still get their header. Never throws.
   */
  rememberAccountEmail: (userId: string, email: string) => Promise<void>;
  /** Drop the account's token (account deleted on this device). Never throws. */
  forgetAccount: (userId: string) => Promise<void>;
};

export function createDeviceTokenStore(
  storage: DeviceTokenStorage,
  options: {
    setTimer?: (callback: () => void, delayMs: number) => unknown;
    clearTimer?: (timer: unknown) => void;
  } = {},
): DeviceTokenStore {
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));

  // One read-modify-write at a time, so a refresh landing beside a sign-in
  // cannot drop either account's token.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<Result>(task: () => Promise<Result>): Promise<Result> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  // Accounts deleted on this device in this app run. A refresh reply already in
  // flight when the account was deleted must not put it back.
  const deletedUserIds = new Set<string>();
  // userId → the email last confirmed on its entry, so a profile that refetches
  // every few minutes does not read the keychain each time.
  const confirmedEmails = new Map<string, string>();
  // The signed-in profile may load before this phone receives its first device token.
  let profileWithoutToken: { userId: string; email: string } | undefined;

  async function readLedger(): Promise<DeviceTokenLedger> {
    return parseDeviceTokenLedger(await storage.read(DEVICE_TOKEN_LEDGER_KEY));
  }

  async function writeLedger(ledger: DeviceTokenLedger): Promise<void> {
    // A failed deletion must not survive the next successful ledger write.
    const retained = ledger.filter((account) => !deletedUserIds.has(account.userId));
    // Any write may move an email between accounts; re-check after it.
    confirmedEmails.clear();
    if (retained.length === 0) await storage.remove(DEVICE_TOKEN_LEDGER_KEY);
    else await storage.write(DEVICE_TOKEN_LEDGER_KEY, serializeDeviceTokenLedger(retained));
  }

  return {
    async rememberFromReply(reply, replyOptions = {}) {
      try {
        // Checks the reply for a token before decoding anything. A backend
        // without device tokens (production until the secret is set): no
        // keychain access at all, so this path is identical to before.
        const received = readDeviceTokenFromReply(reply, () => userIdFromJwt(replyOptions.jwt));
        if (received === null) return;
        await enqueue(async () => {
          if (deletedUserIds.has(received.userId)) return;
          const ledger = await readLedger();
          const email =
            replyOptions.email ??
            (profileWithoutToken?.userId === received.userId ? profileWithoutToken.email : undefined);
          const next = mergeDeviceTokenReply(ledger, { ...received, email });
          await writeLedger(next);
          if (
            profileWithoutToken &&
            (profileWithoutToken.userId === received.userId ||
              profileWithoutToken.email === usableDeviceTokenEmail(replyOptions.email))
          )
            profileWithoutToken = undefined;
        });
      } catch {
        // Recognition is an optimisation for the guess counter, never a
        // condition of signing in. A failed write leaves the old ledger.
      }
    },

    async rememberAccountEmail(userId, email) {
      try {
        const normalised = usableDeviceTokenEmail(email);
        if (
          normalised === null ||
          confirmedEmails.get(userId) === normalised ||
          (profileWithoutToken?.userId === userId && profileWithoutToken.email === normalised)
        )
          return;
        await enqueue(async () => {
          if (deletedUserIds.has(userId)) return;
          const ledger = await readLedger();
          const next = setDeviceTokenAccountEmail(ledger, userId, normalised);
          if (next !== ledger) await writeLedger(next);
          if (next.some((account) => account.userId === userId && account.email === normalised)) {
            confirmedEmails.set(userId, normalised);
            if (profileWithoutToken?.email === normalised || profileWithoutToken?.userId === userId)
              profileWithoutToken = undefined;
          } else {
            profileWithoutToken = { userId, email: normalised };
          }
        });
      } catch {
        // The header is only ever an exemption; without the email, none is sent.
      }
    },

    headersForCredentialsSignIn(email) {
      const lookup = enqueue(async () => {
        const ledger = await readLedger();
        // Keychain cleanup can fail temporarily; the in-memory deletion still
        // wins when storage becomes readable again in this app run.
        return chooseDeviceTokenForEmail(
          ledger.filter((account) => !deletedUserIds.has(account.userId)),
          email,
        );
      }).catch(() => null);
      let timer: unknown;
      const deadline = new Promise<null>((resolve) => {
        timer = setTimer(() => resolve(null), HEADER_READ_DEADLINE_MS);
      });
      return Promise.race([lookup, deadline]).then((token): Record<string, string> => {
        clearTimer(timer);
        if (token === null) return {};
        return { [NATIVE_DEVICE_TOKEN_HEADER]: token };
      });
    },

    async forgetAccount(userId) {
      try {
        deletedUserIds.add(userId);
        confirmedEmails.delete(userId);
        if (profileWithoutToken?.userId === userId) profileWithoutToken = undefined;
        await enqueue(async () => {
          const ledger = await readLedger();
          const next = forgetDeviceTokenAccount(ledger, userId);
          if (next.length !== ledger.length) await writeLedger(next);
        });
      } catch {
        // Best effort, like the rest of the post-deletion local cleanup.
      }
    },
  };
}

const deviceTokenStore = createDeviceTokenStore({
  read: readSecureValue,
  write: writeSecureValue,
  remove: deleteSecureValue,
});

export const rememberDeviceTokenFromReply = deviceTokenStore.rememberFromReply;
export const deviceTokenHeadersForCredentialsSignIn = deviceTokenStore.headersForCredentialsSignIn;
export const forgetDeviceTokenForAccount = deviceTokenStore.forgetAccount;
export const rememberDeviceTokenAccountEmail = deviceTokenStore.rememberAccountEmail;
