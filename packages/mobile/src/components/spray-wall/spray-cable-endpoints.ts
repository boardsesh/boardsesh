/**
 * The marked ends of an LED cable. A WLED strip is one chain, so a cable cut
 * into sections has loose ends to reconnect: the end of every section but the
 * last and the start of every section but the first. `start` is where the
 * strip's data line enters; `end` is where Lay cable and Light and tap extend it.
 */
export function cableEndpoints(paths: readonly (readonly string[])[]): {
  start: string | null;
  end: string | null;
  loose: string[];
} {
  const sections = paths.filter((path) => path.length > 0);
  const loose: string[] = [];
  sections.forEach((path, index) => {
    if (index > 0) loose.push(path[0]);
    if (index < sections.length - 1) loose.push(path[path.length - 1]);
  });
  return {
    start: sections[0]?.[0] ?? null,
    end: sections.at(-1)?.at(-1) ?? null,
    loose: [...new Set(loose)],
  };
}
