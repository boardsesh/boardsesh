import { getAuthToken } from './auth-store';
import { userIdFromJwt } from './jwt-user-id';

/**
 * The signed-in user's id this device can answer WITHOUT the network — the id
 * `board.ownerId` is compared against, so "your boards" can be told apart from
 * the ones you follow when `useProfile` (a plain network query) has no answer.
 *
 * Display-only on both platforms: native decodes an unverified JWT (see
 * `userIdFromJwt`), web reports the last identity its session confirmed. Never
 * feed it into an authorization decision or a mutation payload.
 */
export type LocalUserIdReader = () => Promise<string | undefined>;

/**
 * Native: the backend signs `SignJWT({ sub: userId })`, so the id is already in
 * the token SecureStore holds and no request has to be made for it.
 */
export const readLocalUserId: LocalUserIdReader = async () => userIdFromJwt(await getAuthToken());
