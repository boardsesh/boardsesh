'use server';

import { redirect } from 'next/navigation';
import { getServerAuthToken } from '@/app/lib/auth/server-auth';
import { readBoardInviteToken } from '@/app/lib/board-invite';
import { redeemBoardInvite } from '@/app/lib/board-invite.server';
import { resolveBoardBySlug } from '@/app/lib/board-slug-utils';
import { getLocale } from '@/app/lib/i18n/get-locale';
import { localeHref } from '@/app/lib/i18n/locale-href';

/** Next verifies the POST origin; GET/prefetch/link-unfurl never calls this. */
export async function joinBoardInvite(token: string): Promise<void> {
  const inviteToken = readBoardInviteToken(token);
  if (!inviteToken) return;
  const authToken = await getServerAuthToken();
  if (!authToken) return;
  const redemption = await redeemBoardInvite(inviteToken, authToken);
  if (!redemption) return;
  const board = await resolveBoardBySlug(redemption.slug);
  if (!board) return;
  redirect(localeHref(`/b/${encodeURIComponent(board.slug)}/${board.angle}/list`, await getLocale()));
}
