import { GraphQLError } from 'graphql';
import { ZodError } from 'zod';
import { isDatabaseLeakError } from '../../graphql/mask-error';
import { logger } from '../../utils/logger';

export function recordGymMcpToolResult(
  tool: string,
  status: 'success' | 'error',
  startedAt: number,
  code?: string,
): void {
  logger.info('Gym MCP tool completed', { tool, status, code, durationMs: Math.round(performance.now() - startedAt) });
}

export function gymMcpToolFailure(error: unknown, tool?: string, startedAt?: number) {
  const code =
    error instanceof ZodError
      ? 'BAD_USER_INPUT'
      : error instanceof GraphQLError && typeof error.extensions.code === 'string'
        ? error.extensions.code
        : 'INTERNAL_SERVER_ERROR';
  const message =
    error instanceof ZodError
      ? 'Check the tool arguments and try again.'
      : error instanceof Error && !isDatabaseLeakError(error) && code !== 'INTERNAL_SERVER_ERROR'
        ? error.message
        : 'The gym action could not be completed. Try again.';
  if (tool !== undefined && startedAt !== undefined) recordGymMcpToolResult(tool, 'error', startedAt, code);
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: { code, message } }) }] };
}
