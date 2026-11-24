import { describe, expect, it } from 'vite-plus/test';
import { buildSchema, parse } from 'graphql';
import { validateOperation } from '../graphql/query-validation';

const schema = buildSchema(`
  type Query { node: Node, scalar: Int }
  type Mutation { node: Node }
  type Subscription { node: Node }
  type Node { child: Node, scalar: Int }
`);

function nestedFields(depth: number): string {
  return `${'child { '.repeat(depth)}scalar${' }'.repeat(depth)}`;
}

function errors(source: string): string[] {
  return validateOperation(schema, parse(source)).map((error) => error.message);
}

describe('shared HTTP and WebSocket operation limits', () => {
  it.each(['query', 'mutation', 'subscription'])('allows a depth-ten %s and rejects depth eleven', (operation) => {
    expect(errors(`${operation} { node { ${nestedFields(8)} } }`)).toEqual([]);
    expect(errors(`${operation} { node { ${nestedFields(9)} } }`)).toContain(
      'Syntax Error: Query depth limit of 10 exceeded, found 11.',
    );
  });

  it('follows named fragments and nested inline fragments', () => {
    expect(errors(`{ node { ...Deep } } fragment Deep on Node { ${nestedFields(9)} }`)).toEqual(
      expect.arrayContaining([expect.stringContaining('Query depth limit of 10 exceeded')]),
    );
    expect(errors(`{ node { ... on Node { ${nestedFields(9)} } } }`)).toEqual(
      expect.arrayContaining([expect.stringContaining('Query depth limit of 10 exceeded')]),
    );
  });

  it('charges aliases separately at the cost boundary', () => {
    const fields = Array.from({ length: 5000 }, (_, index) => `field${index}: scalar`).join(' ');
    expect(errors(`{ ${fields} }`)).toEqual([]);
    expect(errors(`{ ${fields} extra: scalar }`)).toEqual([
      'Syntax Error: Query Cost limit of 5000 exceeded, found 5001.',
    ]);
  });

  it('charges repeated fragment spreads beneath separate aliases', () => {
    const fields = Array.from({ length: 1000 }, (_, index) => `field${index}: node { ...Fields }`).join(' ');
    expect(errors(`{ ${fields} } fragment Fields on Node { scalar }`)).toEqual(
      expect.arrayContaining([expect.stringContaining('Query Cost limit of 5000 exceeded')]),
    );
  });

  it('validates every operation in a document', () => {
    const source = `query Safe { scalar } query Deep { node { ...Fields } }
      fragment Fields on Node { ${nestedFields(9)} }`;
    expect(errors(source)).toEqual(expect.arrayContaining([expect.stringContaining('Query depth limit')]));
  });

  it('rejects fragment cycles using normal validation without recursion failure', () => {
    expect(errors('{ node { ...Cycle } } fragment Cycle on Node { child { ...Cycle } }')).toEqual(
      expect.arrayContaining([expect.stringContaining('Cannot spread fragment "Cycle" within itself')]),
    );
  });

  it('keeps ordinary schema validation', () => {
    expect(errors('{ missing }')).toEqual(['Cannot query field "missing" on type "Query".']);
  });
});
