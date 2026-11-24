import { describe, expect, it, vi } from 'vite-plus/test';
import { buildASTSchema, graphql, parse, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import {
  PublishSprayWallVersionInputSchema,
  RemoveSprayWallHoldsInputSchema,
  UpsertSprayWallHoldsInputSchema,
} from '../validation/schemas/spray-walls';

const WALL_UUID = '478a7415-0e57-47cb-90e8-493c6c253074';
const writes = [
  {
    mutation: 'upsertSprayWallHolds',
    inputType: 'UpsertSprayWallHoldsInput',
    validator: UpsertSprayWallHoldsInputSchema,
    input: { wallUuid: WALL_UUID, versionId: '42', holds: [{ id: 7, cx: 20, cy: 30, r: 10 }] },
    selection: '{ id }',
    result: [{ id: 7 }],
  },
  {
    mutation: 'removeSprayWallHolds',
    inputType: 'RemoveSprayWallHoldsInput',
    validator: RemoveSprayWallHoldsInputSchema,
    input: { wallUuid: WALL_UUID, versionId: '42', holdIds: [7] },
    selection: '',
    result: 1,
  },
  {
    mutation: 'publishSprayWallVersion',
    inputType: 'PublishSprayWallVersionInput',
    validator: PublishSprayWallVersionInputSchema,
    input: { versionId: '42' },
    selection: '{ id }',
    result: { id: '42' },
  },
] as const;

const currentDocument = parse(typeDefs.join('\n'));
const currentSchema = buildASTSchema(currentDocument);
// Model the rollback boundary using the actual schema with only this feature's
// input fields removed. No production resolver or database write is involved.
const legacySchema = buildASTSchema(
  visit(currentDocument, {
    InputObjectTypeDefinition(node) {
      if (!writes.some(({ inputType }) => inputType === node.name.value)) return undefined;
      return { ...node, fields: node.fields?.filter((field) => field.name.value !== 'preserveClimbLinks') };
    },
  }),
);

describe.each(writes)(
  '$mutation climb-link preservation contract',
  ({ mutation, inputType, validator, input, selection, result }) => {
    const source = `mutation ($input: ${inputType}!) { ${mutation}(input: $input) ${selection} }`;

    it('accepts a required link-preserving writer on the current backend', async () => {
      const write = vi.fn(({ input: submitted }: { input: unknown }) => {
        expect(validator.parse(submitted)).toMatchObject({ preserveClimbLinks: true });
        return result;
      });
      const response = await graphql({
        schema: currentSchema,
        source,
        variableValues: { input: { ...input, preserveClimbLinks: true } },
        rootValue: { [mutation]: write },
      });
      expect(response.errors).toBeUndefined();
      expect(write).toHaveBeenCalledTimes(1);
      expect(response.data?.[mutation]).toEqual(result);
    });

    it('rejects a marked request on an old backend before any writer runs', async () => {
      const write = vi.fn(() => result);
      const response = await graphql({
        schema: legacySchema,
        source,
        variableValues: { input: { ...input, preserveClimbLinks: true } },
        rootValue: { [mutation]: write },
      });
      expect(response.errors).toHaveLength(1);
      expect(response.errors?.[0].message).toContain(
        `Field "preserveClimbLinks" is not defined by type "${inputType}"`,
      );
      expect(response.data).toBeUndefined();
      expect(write).not.toHaveBeenCalled();
    });

    it('keeps unmarked older-client requests compatible with both schemas', async () => {
      expect(validator.parse(input)).not.toHaveProperty('preserveClimbLinks');
      for (const schema of [legacySchema, currentSchema]) {
        const write = vi.fn(() => result);
        const response = await graphql({ schema, source, variableValues: { input }, rootValue: { [mutation]: write } });
        expect(response.errors).toBeUndefined();
        expect(write).toHaveBeenCalledTimes(1);
      }
    });

    it.each([false, null, 'true', 1])('rejects an invalid preservation requirement: %j', (preserveClimbLinks) => {
      expect(validator.safeParse({ ...input, preserveClimbLinks }).success).toBe(false);
    });
  },
);
