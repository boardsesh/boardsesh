/**
 * Does a recorded response still carry every field the app's current document
 * asks for?
 *
 * A screenshot fixture is keyed on the document HASH, so a query that grew a
 * field simply misses its fixture and the replay backend says so loudly. This
 * walker catches the other half: a fixture whose hash still matches but whose
 * body no longer answers the selection — the server stopped returning a field,
 * or the fixture was hand-edited. That one is silent. The app renders the screen
 * with a blank where the value was, and the store set ships with the hole.
 *
 * Used only by screenshot-fixture-drift.test.ts; it lives beside the test rather
 * than in src/ because nothing at runtime has any use for it.
 */

import {
  Kind,
  isAbstractType,
  isObjectType,
  type DirectiveNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type GraphQLSchema,
  type SelectionSetNode,
  type ValueNode,
} from 'graphql';

/** A `@skip` / `@include` argument, as far as a fixture's variables can settle it. */
function booleanArgument(node: ValueNode, variables: Record<string, unknown>): boolean | null {
  if (node.kind === Kind.BOOLEAN) return node.value;
  if (node.kind === Kind.VARIABLE) return Boolean(variables[node.name.value]);
  return null;
}

function directiveCondition(
  directives: readonly DirectiveNode[] | undefined,
  directiveName: string,
  variables: Record<string, unknown>,
): boolean | null {
  const directive = directives?.find((candidate) => candidate.name.value === directiveName);
  const condition = directive?.arguments?.find((argument) => argument.name.value === 'if');
  if (!condition) return null;
  return booleanArgument(condition.value, variables);
}

/**
 * Whether this selection is actually part of the response the fixture recorded.
 *
 * `@skip(if: $x)` / `@include(if: $x)` are evaluated against the fixture's own
 * variables, which is the only honest reading: a fixture recorded with
 * `$withStats: false` never asked for the stats block, so demanding it back
 * would fail every run.
 */
function isSelected(directives: readonly DirectiveNode[] | undefined, variables: Record<string, unknown>): boolean {
  if (directiveCondition(directives, 'skip', variables) === true) return false;
  if (directiveCondition(directives, 'include', variables) === false) return false;
  return true;
}

/**
 * Whether a fragment on `typeConditionName` applies to this response object.
 *
 * Without a `__typename` in the recorded body there is no way to tell, so the
 * fragment is treated as optional rather than guessed at — a union arm the
 * response is not is the normal case, and reporting its fields as missing would
 * be pure noise.
 */
function fragmentApplies(
  schema: GraphQLSchema,
  typeConditionName: string | null,
  parent: Record<string, unknown>,
): boolean {
  if (!typeConditionName) return true;
  const typename = parent.__typename;
  if (typeof typename !== 'string') return false;
  if (typename === typeConditionName) return true;
  const conditionType = schema.getType(typeConditionName);
  const concreteType = schema.getType(typename);
  if (isAbstractType(conditionType) && isObjectType(concreteType)) return schema.isSubType(conditionType, concreteType);
  return false;
}

/**
 * Every response path the operation selects but the recorded body does not
 * answer, in document order. Empty means the fixture still covers the document.
 *
 * Paths read like the response: `myBoards.boards[0].name`, alias where the
 * document used one (the alias IS the response key).
 */
export function checkSelectionCoverage(
  schema: GraphQLSchema,
  document: DocumentNode,
  responseData: unknown,
  variables: Record<string, unknown> = {},
): string[] {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition);
  }
  const operation = document.definitions.find((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) return [];

  const missing: string[] = [];

  const walk = (selectionSet: SelectionSetNode, value: unknown, path: string): void => {
    // A null parent legitimately answers nothing: `climb: null` is a complete
    // response, not a fixture that lost the climb's fields.
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
      value.forEach((element, index) => walk(selectionSet, element, `${path}[${index}]`));
      return;
    }
    // A scalar where an object was selected owns none of the selected keys, so
    // it falls through the field loop below and every field is reported — which
    // is exactly right, and needs no special case.
    const parent = typeof value === 'object' ? (value as Record<string, unknown>) : {};

    for (const selection of selectionSet.selections) {
      if (!isSelected(selection.directives, variables)) continue;

      if (selection.kind === Kind.FIELD) {
        const responseKey = selection.alias?.value ?? selection.name.value;
        const childPath = path ? `${path}.${responseKey}` : responseKey;
        if (!Object.hasOwn(parent, responseKey)) {
          missing.push(childPath);
          continue;
        }
        if (selection.selectionSet) walk(selection.selectionSet, parent[responseKey], childPath);
        continue;
      }

      if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (!fragmentApplies(schema, selection.typeCondition?.name.value ?? null, parent)) continue;
        walk(selection.selectionSet, value, path);
        continue;
      }

      const fragment = fragments.get(selection.name.value);
      if (!fragment) continue;
      if (!fragmentApplies(schema, fragment.typeCondition.name.value, parent)) continue;
      walk(fragment.selectionSet, value, path);
    }
  };

  walk(operation.selectionSet, responseData, '');
  return missing;
}
