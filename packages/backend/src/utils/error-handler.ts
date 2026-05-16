import { GraphQLError } from 'graphql';
import { logger } from './logger';
/**
 * Error handling utilities for preventing information disclosure.
 */

/**
 * Wrap a database operation to prevent leaking internal error details.
 * Logs the full error internally but returns a sanitized error to the caller.
 *
 * @param operation - Async function that performs the database operation
 * @param context - Context string for logging (e.g., 'joinSession', 'updateQueue')
 * @returns Result of the operation
 * @throws Sanitized error if operation fails
 */
export async function wrapDatabaseOperation<T>(operation: () => Promise<T>, context: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Log the full error internally for debugging
    logger.error(`[${context}] Database operation failed:`, error);

    // Pass through structured GraphQL errors (rate limits, etc.) so client-side
    // handling can inspect extensions.code instead of regex-parsing the message.
    if (error instanceof GraphQLError) {
      throw error;
    }

    // Check for specific error types we want to handle specially
    if (error instanceof Error) {
      // Preserve version conflict errors (these are expected)
      if (error.name === 'VersionConflictError') {
        throw error;
      }

      // Check for common database errors
      if (error.message.includes('connection refused') || error.message.includes('ECONNREFUSED')) {
        throw new Error('Service temporarily unavailable. Please try again later.');
      }

      if (error.message.includes('timeout') || error.message.includes('ETIMEDOUT')) {
        throw new Error('Operation timed out. Please try again.');
      }

      if (error.message.includes('duplicate key') || error.message.includes('unique constraint')) {
        throw new Error('This operation conflicts with existing data.');
      }

      // Check for validation errors from Zod
      if (error.message.startsWith('Invalid ')) {
        throw error; // These are safe to pass through
      }

      // Check for auth/rate limit errors
      if (
        error.message.includes('Rate limit') ||
        error.message.includes('Authentication required') ||
        error.message.includes('Unauthorized')
      ) {
        throw error; // These are safe to pass through
      }
    }

    // Generic error for anything else - don't leak internal details
    throw new Error('An unexpected error occurred. Please try again.');
  }
}

/**
 * Log a security event for monitoring purposes.
 * @param event - Event details to log
 */
export function logSecurityEvent(event: {
  type: 'auth_failure' | 'rate_limit' | 'unauthorized_access' | 'validation_error' | 'suspicious_activity';
  connectionId?: string;
  userId?: string;
  details: string;
  metadata?: Record<string, unknown>;
}): void {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level: 'security',
    ...event,
  };

  // Log to console in structured format
  logger.info('[SECURITY]', JSON.stringify(logEntry));

  // In production, this could be sent to a security monitoring service
}
