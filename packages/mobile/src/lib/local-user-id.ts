import { getAuthToken } from './auth-store';
import { userIdFromJwt } from './jwt-user-id';

/**
 * The signed-in user's id this device can answer WITHOUT the network — the id
 * `board.ownerId` is compared against, so "your boards" can be told apart from
 * the ones you follow when `useProfile` (a plain network query) has no answer.
 *
 * Unverified on both platforms: native decodes the JWT without checking its
 * signature (see `userIdFromJwt`), web reports the last identity its session
 * confirmed. It tells which account's rows already on this phone may answer
 * locally. Offline reads compare it with the owner stamp
 * (`canServeLocalUserData`, the ownership check in `offline-request.ts`), a draft
 * opens locally only when its `user_id` matches it, and the queue restore uses it
 * the same way. All of that is data this phone already received for the account
 * the token belongs to. It is never sent as identity: never put it in a mutation
 * payload, and never let it grant access to anything the server has not sent.
 * Consent synchronization also uses it as a local request fence alongside a
 * present credential and the auth generation; the backend authenticates every
 * request. The browser identity can outlive its token, so it cannot replace
 * either check.
 */
export type LocalUserIdReader = (token?: string) => Promise<string | undefined>;

/**
 * Native: the backend signs `SignJWT({ sub: userId })`, so the id is already in
 * the token SecureStore holds and no request has to be made for it. Callers
 * that already read a credential can reuse it without another SecureStore read.
 */
export const readLocalUserId: LocalUserIdReader = async (token) => userIdFromJwt(token ?? (await getAuthToken()));
