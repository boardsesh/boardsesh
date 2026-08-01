export function isGlobalCommunityAdmin(role: { role: string; boardType?: string | null }): boolean {
  return role.role === 'admin' && role.boardType == null;
}
