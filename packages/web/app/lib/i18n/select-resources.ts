/** Select only the translation branches needed by client islands on this page. */
export function selectI18nResources(
  resources: Record<string, Record<string, unknown>>,
  resourceKeys: Readonly<Record<string, readonly string[]>> = {},
): Record<string, Record<string, unknown>> {
  const selected: Record<string, Record<string, unknown>> = {};
  for (const [namespace, catalog] of Object.entries(resources)) {
    const paths = resourceKeys[namespace];
    if (!paths) {
      selected[namespace] = catalog;
      continue;
    }
    const subtree: Record<string, unknown> = {};
    for (const path of paths) {
      const segments = path.split('.');
      if (
        segments.some(
          (segment) => !segment || segment === '__proto__' || segment === 'constructor' || segment === 'prototype',
        )
      ) {
        throw new Error(`Invalid translation branch: ${namespace}.${path}`);
      }
      let source: unknown = catalog;
      for (const segment of segments) {
        source =
          source && typeof source === 'object' && Object.hasOwn(source, segment)
            ? (source as Record<string, unknown>)[segment]
            : undefined;
      }
      if (source === undefined) throw new Error(`Missing translation branch: ${namespace}.${path}`);
      let target = subtree;
      for (const segment of segments.slice(0, -1)) {
        target[segment] ??= {};
        target = target[segment] as Record<string, unknown>;
      }
      target[segments[segments.length - 1]] = source;
    }
    selected[namespace] = subtree;
  }
  return selected;
}
