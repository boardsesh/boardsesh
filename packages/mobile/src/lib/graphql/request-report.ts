import type { ReleaseContextInput } from '@boardsesh/shared-schema';

type ReportInputType = 'SubmitAppFeedbackInput' | 'SubmitQaVerdictInput' | 'ReportClimbInput' | 'ReportSprayWallInput';

function rejectsReleaseContextBeforeExecution(error: unknown, inputType: ReportInputType): boolean {
  if (error === null || typeof error !== 'object') return false;
  const response = (error as Record<string, unknown>).response;
  if (response === null || typeof response !== 'object') return false;
  const responseRecord = response as Record<string, unknown>;
  if (responseRecord.data != null) return false;
  if (responseRecord.status !== undefined && responseRecord.status !== 200 && responseRecord.status !== 400)
    return false;
  const errors = responseRecord.errors;
  if (!Array.isArray(errors) || errors.length === 0) return false;
  const clause = `Field "releaseContext" is not defined by type "${inputType}".`;
  return errors.every((graphqlError: unknown) => {
    if (graphqlError === null || typeof graphqlError !== 'object') return false;
    const errorRecord = graphqlError as Record<string, unknown>;
    if (errorRecord.path !== undefined) return false;
    const extensions = errorRecord.extensions;
    if (extensions !== null && typeof extensions === 'object') {
      const code = (extensions as Record<string, unknown>).code;
      if (code !== undefined && code !== 'BAD_USER_INPUT' && code !== 'GRAPHQL_VALIDATION_FAILED') return false;
    }
    const message = errorRecord.message;
    return (
      typeof message === 'string' &&
      (message === clause ||
        (message.startsWith('Variable "$input" got invalid value ') && message.endsWith(`; ${clause}`)))
    );
  });
}

/** Preview bundles can precede the backend schema; an input-coercion failure executes no resolver. */
export async function requestReport<
  Response,
  Variables extends { input: { releaseContext?: ReleaseContextInput | null } },
>(
  request: (variables: Variables) => Promise<Response>,
  variables: Variables,
  inputType: ReportInputType,
): Promise<Response> {
  try {
    return await request(variables);
  } catch (error) {
    if (!Object.hasOwn(variables.input, 'releaseContext') || !rejectsReleaseContextBeforeExecution(error, inputType)) {
      throw error;
    }
    const fallbackVariables: Variables = { ...variables, input: { ...variables.input } };
    delete fallbackVariables.input.releaseContext;
    // A single retry, outside the catch: any error here is returned to the user.
    return request(fallbackVariables);
  }
}
