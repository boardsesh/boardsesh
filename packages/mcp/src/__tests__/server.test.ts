import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolResult, createServer } from '../server';
import { Runtime } from '../runtime';
import { PrepareWorkoutSchema } from '../workouts';
import { SearchLogbookSchema, SummaryLogbookSchema } from '../history';
import { BOARD_TYPES } from '@boardsesh/public-api';

describe('MCP tool boundary', () => {
  it('never exposes raw exception contents', async () => {
    const result = await toolResult(() => {
      throw new Error('Bearer secret-token /private/account.sqlite');
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result)).not.toContain('/private');
  });
  it('has a JSON-serializable workout input schema with concrete board types', () => {
    const schema = z.toJSONSchema(PrepareWorkoutSchema, { io: 'input' });
    expect(JSON.stringify(schema)).toContain('fourByFour');
    expect(JSON.stringify(schema)).toContain('moonboard');
  });
  it('publishes the supported history boards and case-insensitive matching in tool schemas', () => {
    for (const input of [SearchLogbookSchema, SummaryLogbookSchema]) {
      const schema = z.toJSONSchema(input, { io: 'input' });
      for (const board of BOARD_TYPES) expect(JSON.stringify(schema)).toContain(board);
      expect(JSON.stringify(schema)).toContain('case-insensitive');
    }
  });
  it('constructs all tools without opening storage or prompting for login', async () => {
    const server = createServer(new Runtime('/nonexistent/never-opened-by-initialize'));
    await server.close();
  });
});
