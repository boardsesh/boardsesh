/** Shared by the importer and lookup so persisted keys match user input. */
export function normalizePlaceSearch(query: string): string {
  return query
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('ł', 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
