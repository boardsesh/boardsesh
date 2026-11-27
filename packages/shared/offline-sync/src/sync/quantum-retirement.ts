/** A redacted retired source climb keeps its canonical key for local tick history. */
export function quantumRetirementSql(prefix = ''): string {
  return `${prefix}board_type = 'quantum' AND ${prefix}is_listed = 0 AND ${prefix}is_hidden = 1
    AND ${prefix}is_boardsesh_authored = 0 AND ${prefix}user_id IS NULL AND ${prefix}controller_route_uuid IS NULL`;
}

export function isQuantumRetirement(document: Record<string, unknown>): boolean {
  return (
    document.board_type === 'quantum' &&
    document.is_listed === false &&
    document.is_hidden === true &&
    document.is_boardsesh_authored === false &&
    document.user_id === null &&
    document.controller_route_uuid === null
  );
}
