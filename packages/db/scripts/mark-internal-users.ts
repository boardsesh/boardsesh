/** Flag audited internal accounts. Read-only unless --apply is explicitly passed. */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray } from 'drizzle-orm';
import { users } from '../src/schema/auth/users.js';

export const AUDITED_INTERNAL_EMAILS = [
  'test22@boardsesh.com',
  'test@boardsesh.com',
  'system@boardsesh.com',
  'recommendations@boardsesh.com',
  'hold-classifier@boardsesh.com',
] as const;

type InternalUserRecord = {
  id: string;
  email: string;
  isInternal: boolean;
};

export type InternalUserBackfillPlan = {
  usersToMark: InternalUserRecord[];
  alreadyInternal: InternalUserRecord[];
  missingEmails: string[];
};

export function planInternalUserBackfill(existingUsers: readonly InternalUserRecord[]): InternalUserBackfillPlan {
  const auditedEmails: ReadonlySet<string> = new Set(AUDITED_INTERNAL_EMAILS);
  const auditedUsers = existingUsers.filter((user) => auditedEmails.has(user.email));
  const existingEmails = new Set(auditedUsers.map((user) => user.email));
  return {
    usersToMark: auditedUsers.filter((user) => !user.isInternal),
    alreadyInternal: auditedUsers.filter((user) => user.isInternal),
    missingEmails: AUDITED_INTERNAL_EMAILS.filter((email) => !existingEmails.has(email)),
  };
}

export async function applyInternalUserBackfill(
  existingUsers: readonly InternalUserRecord[],
  options: { apply?: boolean; markInternal: (userIds: readonly string[]) => Promise<number> },
): Promise<{ plan: InternalUserBackfillPlan; updatedCount: number }> {
  const plan = planInternalUserBackfill(existingUsers);
  const updatedCount =
    options.apply && plan.usersToMark.length > 0
      ? await options.markInternal(plan.usersToMark.map((user) => user.id))
      : 0;
  return { plan, updatedCount };
}

export function parseMarkInternalUsersArgs(args: readonly string[]): { apply: boolean; help: boolean } {
  const flags = args.filter((argument) => argument !== '--');
  if (flags.some((argument) => !['--apply', '--dry-run', '--help'].includes(argument))) {
    throw new Error('Expected --apply, --dry-run, or --help');
  }
  if (flags.includes('--apply') && flags.includes('--dry-run')) {
    throw new Error('Choose either --apply or --dry-run');
  }
  return { apply: flags.includes('--apply'), help: flags.includes('--help') };
}

async function main(): Promise<void> {
  const { apply, help } = parseMarkInternalUsersArgs(process.argv.slice(2));
  if (help) {
    console.info('Mark audited internal accounts: --dry-run (default), --apply');
    return;
  }
  const { createScriptDb, getScriptDatabaseUrl, describeDatabaseHost } = await import('./db-connection.js');
  const databaseUrl = getScriptDatabaseUrl();
  console.info(`Internal account backfill ${apply ? 'apply' : 'dry-run'}: ${describeDatabaseHost(databaseUrl)}`);
  const { db, close } = createScriptDb(databaseUrl);
  try {
    const existingUsers = await db
      .select({ id: users.id, email: users.email, isInternal: users.isInternal })
      .from(users)
      .where(inArray(users.email, [...AUDITED_INTERNAL_EMAILS]));
    const { plan, updatedCount } = await applyInternalUserBackfill(existingUsers, {
      apply,
      markInternal: async (userIds) => {
        const updatedUsers = await db
          .update(users)
          .set({ isInternal: true, updatedAt: new Date() })
          .where(
            and(
              inArray(users.id, [...userIds]),
              inArray(users.email, [...AUDITED_INTERNAL_EMAILS]),
              eq(users.isInternal, false),
            ),
          )
          .returning({ id: users.id });
        return updatedUsers.length;
      },
    });
    console.info(
      JSON.stringify({
        mode: apply ? 'apply' : 'dry-run',
        plannedEmails: plan.usersToMark.map((user) => user.email),
        alreadyInternalEmails: plan.alreadyInternal.map((user) => user.email),
        missingEmails: plan.missingEmails,
        updatedCount,
      }),
    );
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    console.error('Internal account backfill failed. Check database connectivity and schema readiness.');
    process.exitCode = 1;
  });
}
