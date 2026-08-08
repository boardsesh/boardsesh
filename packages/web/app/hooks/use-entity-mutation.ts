'use client';

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { extractGraphQLErrorMessage } from '@/app/lib/graphql/extract-error-message';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { Variables } from 'graphql-request';

// `errorMessage` is required unless `onError` is provided: without a
// caller-owned handler the hook is the one showing the toast on failure, and
// it needs a message to show. When `onError` is set, the caller owns the
// error toast (and its own i18n fallback — see `handleUpdateError`-style
// callbacks), so `errorMessage` becomes optional and is only used to label the
// `console.error` on failure.
type UseEntityMutationOptions =
  | {
      successMessage?: string;
      errorMessage: string;
      authRequiredMessage?: string;
      onError?: undefined;
    }
  | {
      successMessage?: string;
      errorMessage?: string;
      authRequiredMessage?: string;
      onError: (error: unknown, serverMessage: string | null) => void | Promise<void>;
    };

export function useEntityMutation<TResponse, TVariables extends Variables = Variables>(
  mutation: TypedDocumentNode | string,
  options: UseEntityMutationOptions,
) {
  const { successMessage, authRequiredMessage } = options;
  const { token } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const { t } = useTranslation('common');
  const resolvedAuthRequiredMessage = authRequiredMessage ?? t('auth.mustBeSignedIn');

  const execute = useCallback(
    async (variables: TVariables): Promise<TResponse | null> => {
      if (!token) {
        showMessage(resolvedAuthRequiredMessage, 'error');
        return null;
      }

      try {
        const client = createGraphQLHttpClient(token);
        const data = await client.request<TResponse>(mutation, variables as Variables);
        if (successMessage) {
          showMessage(successMessage, 'success');
        }
        return data;
      } catch (error) {
        console.error(options.errorMessage, error);
        const serverMessage = extractGraphQLErrorMessage(error);
        if (options.onError) {
          await options.onError(error, serverMessage);
        } else {
          showMessage(serverMessage ?? options.errorMessage, 'error');
        }
        return null;
      }
    },
    [token, mutation, successMessage, options.errorMessage, resolvedAuthRequiredMessage, options.onError, showMessage],
  );

  return { execute, token };
}
