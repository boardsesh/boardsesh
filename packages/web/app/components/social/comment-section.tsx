'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiTypography from '@mui/material/Typography';
import type { SocialEntityType } from '@boardsesh/shared-schema';
import { useSession } from 'next-auth/react';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import { createGraphQLClient, subscribe } from '@/app/lib/realtime/graphql-client';
import {
  ADD_COMMENT,
  type AddCommentMutationVariables,
  type AddCommentMutationResponse,
  COMMENT_UPDATES_SUBSCRIPTION,
  type CommentUpdatesSubscriptionResponse,
  type CommentUpdatesSubscriptionVariables,
} from '@boardsesh/graphql/operations';
import CommentForm from './comment-form';
import CommentList from './comment-list';

type CommentSectionProps = {
  entityType: SocialEntityType;
  entityId: string;
  title?: string;
};

export default function CommentSection({ entityType, entityId, title }: CommentSectionProps) {
  const { t } = useTranslation('common');
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: session } = useSession();
  const { token, isAuthenticated } = useWsAuthToken();
  const currentUserId = session?.user?.id ?? null;
  const { showMessage } = useSnackbar();
  const wsClientRef = useRef<ReturnType<typeof createGraphQLClient> | null>(null);
  const resolvedTitle = title ?? t('comment.discussionTitle');

  // Set up live comment updates subscription
  useEffect(() => {
    const wsUrl = getBackendWsUrl();
    if (!wsUrl) return;

    const wsClient = createGraphQLClient({ url: wsUrl, authToken: token });
    wsClientRef.current = wsClient;

    const unsub = subscribe<CommentUpdatesSubscriptionResponse, CommentUpdatesSubscriptionVariables>(
      wsClient,
      {
        query: COMMENT_UPDATES_SUBSCRIPTION,
        variables: { entityType, entityId },
      },
      {
        next: (data) => {
          if (data?.commentUpdates) {
            // Any comment change triggers a refresh
            setRefreshKey((prev) => prev + 1);
          }
        },
        error: (err) => {
          console.error('[CommentSection] Subscription error:', err);
        },
        complete: () => {
          // Subscription ended
        },
      },
    );

    return () => {
      unsub();
      void wsClient.dispose();
      wsClientRef.current = null;
    };
  }, [entityType, entityId, token]);

  const handleAddComment = useCallback(
    async (body: string) => {
      if (!token) return;
      try {
        const client = createGraphQLHttpClient(token);
        await client.request<AddCommentMutationResponse, AddCommentMutationVariables>(ADD_COMMENT, {
          input: { entityType, entityId, body },
        });
        setRefreshKey((prev) => prev + 1);
      } catch {
        showMessage(t('comment.errors.post'), 'error');
        throw new Error('Failed to post comment');
      }
    },
    [token, entityType, entityId, showMessage, t],
  );

  return (
    <Box>
      <MuiTypography variant="h6" sx={{ mb: 2 }}>
        {resolvedTitle}
      </MuiTypography>

      {isAuthenticated ? (
        <Box sx={{ mb: 2 }}>
          <CommentForm onSubmit={handleAddComment} placeholder={t('comment.thoughtsPlaceholder')} />
        </Box>
      ) : (
        <MuiTypography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {t('comment.signInPrompt')}
        </MuiTypography>
      )}

      <CommentList entityType={entityType} entityId={entityId} refreshKey={refreshKey} currentUserId={currentUserId} />
    </Box>
  );
}
