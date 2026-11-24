import { costLimitRule } from '@escape.tech/graphql-armor-cost-limit';
import { maxDepthRule } from '@escape.tech/graphql-armor-max-depth';
import { specifiedRules, validate, type GraphQLError, type ValidationContext, type ValidationRule } from 'graphql';
import type { Plugin } from 'graphql-yoga';

function reportLimitError(context: ValidationContext | null, error: GraphQLError): void {
  if (!context) throw error;
  context.reportError(error);
}

// Keep HTTP and WebSocket operations on the same limits, including documents
// that reach nested fields through fragments. Report errors through GraphQL's
// normal validation path so WebSocket failures do not close the connection or
// bypass the existing credential-redaction hooks.
export const operationLimitRules: readonly ValidationRule[] = [
  maxDepthRule({
    n: 10,
    propagateOnRejection: false,
    onReject: [reportLimitError],
  }),
  costLimitRule({
    maxCost: 5000,
    propagateOnRejection: false,
    onReject: [reportLimitError],
  }),
];

export const validateOperation: typeof validate = (schema, document, rules = specifiedRules, options, typeInfo) =>
  validate(schema, document, [...rules, ...operationLimitRules], options, typeInfo);

export function operationLimitsPlugin(): Plugin {
  return {
    onValidate({ addValidationRule }) {
      for (const rule of operationLimitRules) addValidationRule(rule);
    },
  };
}
