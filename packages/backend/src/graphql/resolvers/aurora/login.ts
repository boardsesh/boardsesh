import { AuroraClimbingClient } from '@boardsesh/aurora-sync';
import { SyncRunner } from '@boardsesh/aurora-sync/runner';
import type { AuroraBoardName } from '@boardsesh/aurora-sync';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { eq, and } from 'drizzle-orm';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { validateInput, applyRateLimit } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

export interface AuroraLoginResult {
  token: string;
  userId: number;
}

const AURORA_BOARD_NAMES: readonly string[] = ['kilter', 'tension'];

function isAuroraBoardName(name: string): name is AuroraBoardName {
  return AURORA_BOARD_NAMES.includes(name);
}

export const auroraLoginMutation = {
  auroraLogin: async (
    _: unknown,
    { boardName, username, password }: {
      boardName: string;
      username: string;
      password: string;
    },
    ctx: ConnectionContext,
  ): Promise<AuroraLoginResult> => {
    await applyRateLimit(ctx, 10, 'auroraLogin');
    validateInput(BoardNameSchema, boardName, 'boardName');

    if (!isAuroraBoardName(boardName)) {
      throw new Error('Unsupported board for this endpoint. Only kilter and tension use Aurora APIs.');
    }

    if (!username || username.length === 0) {
      throw new Error('Username is required');
    }
    if (!password || password.length === 0) {
      throw new Error('Password is required');
    }

    const auroraClient = new AuroraClimbingClient({ boardName });

    let loginResponse;
    try {
      loginResponse = await auroraClient.signIn(username, password);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('401')) {
          throw new Error('Invalid credentials');
        }
        if (error.message.includes('403')) {
          throw new Error('Access forbidden');
        }
        if (error.message.startsWith('HTTP error!')) {
          throw new Error('Service unavailable');
        }
      }
      throw error;
    }

    if (!loginResponse.token || !loginResponse.user_id) {
      throw new Error('Invalid login response: missing token or user_id');
    }

    // Insert/update user in our database
    const createdAt = loginResponse.user?.created_at
      ? new Date(loginResponse.user.created_at).toISOString()
      : new Date().toISOString();

    await db
      .insert(dbSchema.boardUsers)
      .values({
        boardType: boardName,
        id: loginResponse.user_id,
        username: loginResponse.username || username,
        createdAt,
      })
      .onConflictDoUpdate({
        target: [dbSchema.boardUsers.boardType, dbSchema.boardUsers.id],
        set: { username: loginResponse.username || username },
      });

    // Fire-and-forget sync for users who have stored credentials
    // (matches original REST behavior of calling syncUserData after login)
    const auroraUserId = loginResponse.user_id;
    db.select({ userId: dbSchema.auroraCredentials.userId })
      .from(dbSchema.auroraCredentials)
      .where(
        and(
          eq(dbSchema.auroraCredentials.boardType, boardName),
          eq(dbSchema.auroraCredentials.auroraUserId, auroraUserId),
        ),
      )
      .limit(1)
      .then((creds) => {
        if (creds.length > 0) {
          const runner = new SyncRunner({
            onLog: (msg: string) => console.log(`[AuroraLogin Sync] ${msg}`),
            onError: (error: Error) => console.error('[AuroraLogin Sync] Error:', error.message),
          });
          return runner.syncUser(creds[0].userId, boardName);
        }
      })
      .catch((err) => {
        console.error('[AuroraLogin] Post-login sync error (non-fatal):', err);
      });

    return {
      token: loginResponse.token,
      userId: loginResponse.user_id,
    };
  },
};
