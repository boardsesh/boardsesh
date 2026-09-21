import { AURORA_BOARDS, type AuroraBoardName } from '@boardsesh/shared-schema';

/** MoonBoard uses file import rather than the credential-linking flow. */
export function isLinkableBoard(boardType: string | undefined): boardType is AuroraBoardName {
  return !!boardType && (AURORA_BOARDS as readonly string[]).includes(boardType);
}

/** An unresolved or failed credential read must not be mistaken for no linked accounts. */
export function hasNoLinkedBoardAccount(
  credentials: readonly { boardType: string }[] | undefined,
): boolean | undefined {
  if (credentials === undefined) return undefined;
  return credentials.length === 0;
}
