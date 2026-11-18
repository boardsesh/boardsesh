import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolResult, createServer } from '../server';
import { Runtime } from '../runtime';
import { PrepareWorkoutSchema } from '../workouts';

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
  it('constructs all tools without opening storage or prompting for login', async () => {
    const server = createServer(new Runtime('/nonexistent/never-opened-by-initialize'));
    await server.close();
  });
});
