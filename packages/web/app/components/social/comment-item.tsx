'use client';

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Box from '@mui/material/Box';
import MuiTypography from '@mui/material/Typography';
import MuiAvatar from '@mui/material/Avatar';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import EditOutlined from '@mui/icons-material/EditOutlined';
import DeleteOutlined from '@mui/icons-material/DeleteOutlined';
import ReplyOutlined from '@mui/icons-material/ReplyOutlined';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import LocaleLink from '@/app/components/i18n/locale-link';
import type { Comment as CommentType, SocialEntityType } from '@boardsesh/shared-schema';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import {
  UPDATE_COMMENT,
  DELETE_COMMENT,
  GET_COMMENTS,
  ADD_COMMENT,
  type UpdateCommentMutationVariables,
  type UpdateCommentMutationResponse,
  type DeleteCommentMutationVariables,
  type DeleteCommentMutationResponse,
  type AddCommentMutationVariables,
  type AddCommentMutationResponse,
  type GetCommentsQueryVariables,
  type GetCommentsQueryResponse,
} from '@boardsesh/graphql/operations';
import { themeTokens } from '@/app/theme/theme-config';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import VoteButton from './vote-button';
import CommentForm from './comment-form';

dayjs.extend(relativeTime);

type CommentItemProps = {
  comment: CommentType;
  onCommentUpdated: (comment: CommentType) => void;
  onCommentDeleted: (uuid: string) => void;
  entityType: SocialEntityType;
  entityId: string;
  depth?: number;
  currentUserId?: string | null;
};

export default function CommentItem({
  comment,
  onCommentUpdated,
  onCommentDeleted,
  entityType,
  entityId,
  depth = 0,
  currentUserId,
}: CommentItemProps) {
  const { t } = useTranslation('common');
  const [isEditing, setIsEditing] = useState(false);
  const [showReplyForm, setShowReplyForm] = useState(false);
  const [replies, setReplies] = useState<CommentType[]>([]);
  const [repliesLoaded, setRepliesLoaded] = useState(false);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const { token, isAuthenticated } = useWsAuthToken();
  const { showMessage } = useSnackbar();

  const isAuthor = isAuthenticated && !!currentUserId && comment.userId === currentUserId;
  const timeAgo = dayjs(comment.createdAt).fromNow();
  const wasEdited = comment.createdAt !== comment.updatedAt;

  const handleEdit = useCallback(
    async (body: string) => {
      if (!token) return;
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<UpdateCommentMutationResponse, UpdateCommentMutationVariables>(
          UPDATE_COMMENT,
          { input: { commentUuid: comment.uuid, body } },
        );
        onCommentUpdated(response.updateComment);
        setIsEditing(false);
      } catch {
        showMessage(t('comment.errors.update'), 'error');
      }
    },
    [token, comment.uuid, onCommentUpdated, showMessage, t],
  );

  const handleDelete = useCallback(async () => {
    if (!token) return;
    try {
      const client = createGraphQLHttpClient(token);
      await client.request<DeleteCommentMutationResponse, DeleteCommentMutationVariables>(DELETE_COMMENT, {
        commentUuid: comment.uuid,
      });
      onCommentDeleted(comment.uuid);
    } catch {
      showMessage(t('comment.errors.delete'), 'error');
    }
  }, [token, comment.uuid, onCommentDeleted, showMessage, t]);

  const handleReply = useCallback(
    async (body: string) => {
      if (!token) return;
      try {
        const client = createGraphQLHttpClient(token);
        const response = await client.request<AddCommentMutationResponse, AddCommentMutationVariables>(ADD_COMMENT, {
          input: {
            entityType,
            entityId,
            parentCommentUuid: comment.uuid,
            body,
          },
        });
        setReplies((prev) => [response.addComment, ...prev]);
        setShowReplyForm(false);
        setRepliesLoaded(true);
      } catch {
        showMessage(t('comment.errors.reply'), 'error');
      }
    },
    [token, entityType, entityId, comment.uuid, showMessage, t],
  );

  const loadReplies = useCallback(async () => {
    if (repliesLoaded || repliesLoading) return;
    setRepliesLoading(true);
    try {
      const client = createGraphQLHttpClient(token);
      const response = await client.request<GetCommentsQueryResponse, GetCommentsQueryVariables>(GET_COMMENTS, {
        input: {
          entityType,
          entityId,
          parentCommentUuid: comment.uuid,
          sortBy: 'new',
          limit: 50,
          offset: 0,
        },
      });
      setReplies(response.comments.comments);
      setRepliesLoaded(true);
    } catch {
      showMessage(t('comment.errors.loadReplies'), 'error');
    } finally {
      setRepliesLoading(false);
    }
  }, [token, entityType, entityId, comment.uuid, repliesLoaded, repliesLoading, showMessage, t]);

  const handleReplyUpdated = useCallback((updated: CommentType) => {
    setReplies((prev) => prev.map((r) => (r.uuid === updated.uuid ? updated : r)));
  }, []);

  const handleReplyDeleted = useCallback(
    (uuid: string) => {
      setReplies((prev) => prev.filter((r) => r.uuid !== uuid));
      onCommentUpdated({ ...comment, replyCount: Math.max(0, comment.replyCount - 1) });
    },
    [comment, onCommentUpdated],
  );

  if (comment.isDeleted) {
    return (
      <Box sx={{ pl: depth > 0 ? 6 : 0, py: 0.5 }}>
        <MuiTypography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
          {t('comment.deleted')}
        </MuiTypography>
        {/* Still show replies if they exist */}
        {comment.replyCount > 0 && !repliesLoaded && depth === 0 && (
          <MuiButton
            size="small"
            onClick={loadReplies}
            disabled={repliesLoading}
            sx={{ textTransform: 'none', ml: -0.5 }}
          >
            {comment.replyCount === 1
              ? t('comment.showRepliesOne')
              : t('comment.showRepliesMany', { count: comment.replyCount })}
          </MuiButton>
        )}
        {replies.map((reply) => (
          <CommentItem
            key={reply.uuid}
            comment={reply}
            onCommentUpdated={handleReplyUpdated}
            onCommentDeleted={handleReplyDeleted}
            entityType={entityType}
            entityId={entityId}
            depth={1}
            currentUserId={currentUserId}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box sx={{ pl: depth > 0 ? 6 : 0, py: 1 }}>
      <Box sx={{ display: 'flex', gap: 1.5 }}>
        {/* Avatar */}
        <MuiAvatar
          src={comment.userAvatarUrl ?? undefined}
          sx={{ width: 28, height: 28, mt: 0.25 }}
          component={LocaleLink}
          href={`/profile/${comment.userId}`}
        >
          {!comment.userAvatarUrl && <PersonOutlined sx={{ fontSize: 16 }} />}
        </MuiAvatar>

        <Box sx={{ flex: 1, minWidth: 0 }}>
          {/* Header */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <MuiTypography
              variant="body2"
              fontWeight={600}
              component={LocaleLink}
              href={`/profile/${comment.userId}`}
              sx={{ textDecoration: 'none', color: 'text.primary' }}
            >
              {comment.userDisplayName || t('comment.userFallback')}
            </MuiTypography>
            <MuiTypography variant="caption" color="text.secondary">
              {timeAgo}
            </MuiTypography>
            {wasEdited && (
              <MuiTypography variant="caption" color="text.secondary">
                {t('comment.edited')}
              </MuiTypography>
            )}
          </Box>

          {/* Body or Edit Form */}
          {isEditing ? (
            <CommentForm
              initialBody={comment.body || ''}
              onSubmit={handleEdit}
              onCancel={() => setIsEditing(false)}
              submitLabel={t('comment.save')}
              autoFocus
            />
          ) : (
            <MuiTypography variant="body2" sx={{ mt: 0.25, whiteSpace: 'pre-wrap' }}>
              {comment.body}
            </MuiTypography>
          )}

          {/* Actions */}
          {!isEditing && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
              <VoteButton
                entityType="comment"
                entityId={comment.uuid}
                initialUpvotes={comment.upvotes}
                initialDownvotes={comment.downvotes}
                initialUserVote={comment.userVote}
              />
              {isAuthenticated && depth === 0 && (
                <MuiButton
                  size="small"
                  startIcon={<ReplyOutlined sx={{ fontSize: 16 }} />}
                  onClick={() => setShowReplyForm(!showReplyForm)}
                  sx={{
                    textTransform: 'none',
                    color: 'var(--neutral-500)',
                    fontSize: themeTokens.typography.fontSize.xs,
                  }}
                >
                  {t('comment.reply')}
                </MuiButton>
              )}
              {isAuthor && (
                <>
                  <IconButton
                    size="small"
                    onClick={() => setIsEditing(true)}
                    sx={{ color: 'var(--neutral-500)' }}
                    aria-label={t('comment.delete.editAria')}
                  >
                    <EditOutlined sx={{ fontSize: 16 }} />
                  </IconButton>
                  {/* TODO: Consider lifting ConfirmPopover to parent to avoid per-comment instances */}
                  <ConfirmPopover
                    title={t('comment.delete.title')}
                    description={t('comment.delete.description')}
                    onConfirm={handleDelete}
                    okText={t('comment.delete.confirm')}
                    okButtonProps={{ color: 'error' }}
                  >
                    <IconButton
                      size="small"
                      sx={{ color: 'var(--neutral-500)' }}
                      aria-label={t('comment.delete.deleteAria')}
                    >
                      <DeleteOutlined sx={{ fontSize: 16 }} />
                    </IconButton>
                  </ConfirmPopover>
                </>
              )}
            </Box>
          )}

          {/* Reply Form */}
          {showReplyForm && (
            <Box sx={{ mt: 1 }}>
              <CommentForm
                onSubmit={handleReply}
                onCancel={() => setShowReplyForm(false)}
                placeholder={t('comment.replyPlaceholder')}
                autoFocus
              />
            </Box>
          )}

          {/* Replies */}
          {comment.replyCount > 0 && !repliesLoaded && depth === 0 && (
            <MuiButton
              size="small"
              onClick={loadReplies}
              disabled={repliesLoading}
              sx={{ textTransform: 'none', mt: 0.5, ml: -0.5 }}
            >
              {comment.replyCount === 1
                ? t('comment.showRepliesOne')
                : t('comment.showRepliesMany', { count: comment.replyCount })}
            </MuiButton>
          )}
          {replies.map((reply) => (
            <CommentItem
              key={reply.uuid}
              comment={reply}
              onCommentUpdated={handleReplyUpdated}
              onCommentDeleted={handleReplyDeleted}
              entityType={entityType}
              entityId={entityId}
              depth={1}
              currentUserId={currentUserId}
            />
          ))}
        </Box>
      </Box>
    </Box>
  );
}
