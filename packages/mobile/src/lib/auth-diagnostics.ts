import {
  beginDiagnosticOperation,
  diagnosticErrorAttributes,
  type DiagnosticAttributes,
  type DiagnosticOperation,
  type DiagnosticOutcome,
} from './mobile-diagnostics';

type AuthDiagnosticResult = {
  outcome: DiagnosticOutcome;
  attributes?: DiagnosticAttributes;
};

/** Callers classify status-bearing results; resolved promises can still be failures. */
export async function runAuthDiagnostic<T>(
  name: string,
  run: (operation: DiagnosticOperation) => Promise<T>,
  classify: (result: T) => AuthDiagnosticResult,
  attributes?: DiagnosticAttributes,
  userInitiated = false,
  parentId?: string,
): Promise<T> {
  const operation = beginDiagnosticOperation('auth', name, { attributes, userInitiated, parentId });
  try {
    const result = await run(operation);
    const diagnostic = classify(result);
    operation.finish(diagnostic.outcome, diagnostic.attributes);
    return result;
  } catch (error) {
    operation.finish(
      error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failure',
      diagnosticErrorAttributes(error),
    );
    throw error;
  }
}

export function classifySignInResult(result: {
  success: boolean;
  cancelled?: boolean;
  redirecting?: boolean;
  status?: number | null;
  authenticated?: boolean;
}): AuthDiagnosticResult {
  return {
    outcome: result.cancelled
      ? 'cancelled'
      : result.success
        ? 'success'
        : result.redirecting
          ? 'superseded'
          : 'failure',
    attributes: {
      status: result.status,
      ...(result.authenticated === false ? { degraded: true } : {}),
    },
  };
}
