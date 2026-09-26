import { Kind, type GraphQLResolveInfo, type SelectionSetNode } from 'graphql';

/**
 * The field names the client selected on the object(s) a resolver returns — one
 * level deep, by schema name (aliases resolved), through inline fragments and
 * named fragment spreads.
 *
 * Returns `null` when there is no resolve info to read (a direct call from a test
 * or another resolver). Callers treat `null` as "every field", so a missing info
 * can only ever cost a join, never drop data a caller needed.
 *
 * `@include` / `@skip` are ignored on purpose: a conditionally skipped field
 * still counts as selected, which again errs toward doing the join.
 */
export function selectedFieldNames(info: GraphQLResolveInfo | undefined): ReadonlySet<string> | null {
  if (!info?.fieldNodes) return null;

  const names = new Set<string>();
  const visitedFragments = new Set<string>();

  const collect = (selectionSet: SelectionSetNode | undefined) => {
    if (!selectionSet) return;
    for (const selection of selectionSet.selections) {
      if (selection.kind === Kind.FIELD) {
        names.add(selection.name.value);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        collect(selection.selectionSet);
      } else if (selection.kind === Kind.FRAGMENT_SPREAD) {
        const fragmentName = selection.name.value;
        if (visitedFragments.has(fragmentName)) continue;
        visitedFragments.add(fragmentName);
        collect(info.fragments?.[fragmentName]?.selectionSet);
      }
    }
  };

  for (const fieldNode of info.fieldNodes) collect(fieldNode.selectionSet);
  return names;
}

/** True when `field` was selected, or when the selection is unknown (`null`). */
export function isFieldSelected(selected: ReadonlySet<string> | null, field: string): boolean {
  return selected === null || selected.has(field);
}
