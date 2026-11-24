import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate, visit } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import {
  GET_GYM_GRADE_COMPARISON,
  GET_GYM_GRADE_COLLECTION_OPTIONS,
  SET_GYM_GRADE_COLLECTION,
} from '@boardsesh/graphql/operations/gyms';
import { gymMcpDocuments } from '../documents';

describe('fixed gym MCP documents', () => {
  const schema = buildSchema(typeDefs.join('\n'));

  for (const [name, source] of Object.entries(gymMcpDocuments)) {
    it(`${name} matches the deployed schema`, () => {
      expect(validate(schema, parse(source)).map((failure) => failure.message)).toEqual([]);
    });
  }

  it('never exposes pairing serials or reporter identities', () => {
    for (const source of Object.values(gymMcpDocuments)) {
      const fields: string[] = [];
      visit(parse(source), {
        Field: (field) => {
          fields.push(field.name.value);
        },
      });
      expect(fields).not.toContain('serialNumber');
      expect(fields).not.toContain('reporter');
      expect(fields).not.toContain('claimantIds');
    }
  });

  it('uses the same fixed grade documents as the regular gym insights page', () => {
    expect(gymMcpDocuments.getGradeComparison).toBe(GET_GYM_GRADE_COMPARISON);
    expect(gymMcpDocuments.getGradeCollectionOptions).toBe(GET_GYM_GRADE_COLLECTION_OPTIONS);
    expect(gymMcpDocuments.setGradeCollection).toBe(SET_GYM_GRADE_COLLECTION);
  });
});
