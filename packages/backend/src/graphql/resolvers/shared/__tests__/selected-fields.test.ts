import { describe, it, expect } from 'vite-plus/test';
import { Kind, parse, type FieldNode, type FragmentDefinitionNode, type GraphQLResolveInfo } from 'graphql';
import { selectedFieldNames, isFieldSelected } from '../selected-fields';

/** Resolve info for the first root field of `query`, with its named fragments. */
function resolveInfoFor(query: string): GraphQLResolveInfo {
  const document = parse(query);
  const operation = document.definitions.find((definition) => definition.kind === Kind.OPERATION_DEFINITION);
  if (!operation || operation.kind !== Kind.OPERATION_DEFINITION) throw new Error('no operation');
  const rootField = operation.selectionSet.selections[0] as FieldNode;
  const fragments: Record<string, FragmentDefinitionNode> = {};
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments[definition.name.value] = definition;
  }
  return { fieldNodes: [rootField], fragments } as unknown as GraphQLResolveInfo;
}

describe('selectedFieldNames', () => {
  it('returns null without resolve info, which isFieldSelected reads as every field', () => {
    expect(selectedFieldNames(undefined)).toBeNull();
    expect(isFieldSelected(null, 'effectiveQuality')).toBe(true);
  });

  it('collects the schema names of direct fields, not their aliases', () => {
    const selected = selectedFieldNames(
      resolveInfoFor('{ userTicks(userId: "u", boardType: "kilter") { a: angle climbUuid } }'),
    );
    expect([...(selected ?? [])].sort()).toEqual(['angle', 'climbUuid']);
    expect(isFieldSelected(selected, 'effectiveQuality')).toBe(false);
  });

  it('follows inline fragments and named fragment spreads', () => {
    const selected = selectedFieldNames(
      resolveInfoFor(`
        query Q { userTicks(userId: "u", boardType: "kilter") { angle ... on Tick { effectiveQuality } ...Grades } }
        fragment Grades on Tick { boardseshDifficulty ...Grades }
      `),
    );
    expect(isFieldSelected(selected, 'angle')).toBe(true);
    expect(isFieldSelected(selected, 'effectiveQuality')).toBe(true);
    expect(isFieldSelected(selected, 'boardseshDifficulty')).toBe(true);
    expect(isFieldSelected(selected, 'boardseshConfidence')).toBe(false);
  });
});
