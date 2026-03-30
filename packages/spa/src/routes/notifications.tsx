import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import List from '@mui/material/List'
import ListItem from '@mui/material/ListItem'
import ListItemText from '@mui/material/ListItemText'
import ListItemAvatar from '@mui/material/ListItemAvatar'
import Avatar from '@mui/material/Avatar'
import AvatarGroup from '@mui/material/AvatarGroup'
import Badge from '@mui/material/Badge'
import Button from '@mui/material/Button'
import { useState, useEffect, useRef, useCallback } from 'react'
import { graphqlClient } from '@/lib/graphql-client'
import { GROUPED_NOTIFICATIONS } from '@/lib/graphql-queries'
import type { GroupedNotificationConnection, GroupedNotification } from '@/lib/types'

export const Route = createFileRoute('/notifications')({
  ssr: false,
  component: NotificationsPage,
  head: () => ({
    meta: [{ title: 'Notifications | Boardsesh' }],
  }),
})

const NOTIFICATION_LABELS: Record<string, string> = {
  new_follower: 'started following you',
  comment_reply: 'replied to your comment',
  comment_on_tick: 'commented on your ascent',
  comment_on_climb: 'commented on a climb',
  vote_on_tick: 'upvoted your ascent',
  vote_on_comment: 'upvoted your comment',
  new_climb: 'set a new climb',
  new_climb_global: 'new climb available',
  proposal_approved: 'proposal was approved',
  proposal_rejected: 'proposal was rejected',
  proposal_vote: 'voted on your proposal',
  proposal_created: 'created a proposal',
}

function getNotificationText(notification: GroupedNotification): string {
  const actorNames = notification.actors
    .map((a) => a.displayName ?? 'Someone')
    .slice(0, 2)
    .join(', ')
  const extra = notification.actorCount > 2 ? ` and ${notification.actorCount - 2} others` : ''
  const action = NOTIFICATION_LABELS[notification.type] ?? 'interacted'
  return `${actorNames}${extra} ${action}`
}

function truncateComment(body: string, maxLength: number): string {
  if (body.length <= maxLength) return `"${body}"`
  return `"${body.slice(0, maxLength)}..."`
}

function NotificationsPage() {
  const [offset, setOffset] = useState(0)
  const pageSize = 20
  const [accumulated, setAccumulated] = useState<GroupedNotification[]>([])
  const prevOffset = useRef(-1)

  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ['groupedNotifications', offset],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        groupedNotifications: GroupedNotificationConnection
      }>(GROUPED_NOTIFICATIONS, { limit: pageSize, offset })
      return result.groupedNotifications
    },
  })

  useEffect(() => {
    if (!data) return
    if (offset === 0) {
      setAccumulated(data.groups)
    } else if (offset !== prevOffset.current) {
      setAccumulated((prev) => [...prev, ...data.groups])
    }
    prevOffset.current = offset
  }, [data, offset])

  const handleLoadMore = useCallback(() => {
    setOffset((o) => o + pageSize)
  }, [])

  const groups = accumulated
  const hasMore = data?.hasMore ?? false

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', width: '100%', p: 2 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
        <Typography variant="h5" component="h1">
          Notifications
        </Typography>
        {data?.unreadCount != null && data.unreadCount > 0 && (
          <Badge badgeContent={data.unreadCount} color="primary" />
        )}
      </Box>

      {isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      ) : error ? (
        <Alert severity="error" sx={{ mt: 2 }}>
          Failed to load notifications. Please make sure you are logged in.
        </Alert>
      ) : groups.length === 0 ? (
        <Box sx={{ py: 4, textAlign: 'center' }}>
          <Typography variant="body1" color="text.secondary">
            No notifications yet.
          </Typography>
        </Box>
      ) : (
        <>
          <List disablePadding>
            {groups.map((notification) => (
              <ListItem
                key={notification.uuid}
                sx={{
                  borderRadius: 1,
                  mb: 0.5,
                  bgcolor: notification.isRead ? 'transparent' : 'action.hover',
                }}
              >
                <ListItemAvatar>
                  {notification.actors.length === 1 ? (
                    <Avatar
                      src={notification.actors[0].avatarUrl ?? undefined}
                      alt={notification.actors[0].displayName ?? 'User'}
                      sx={{ width: 40, height: 40 }}
                    >
                      {(notification.actors[0].displayName ?? 'U')[0].toUpperCase()}
                    </Avatar>
                  ) : (
                    <AvatarGroup max={3} sx={{ '& .MuiAvatar-root': { width: 28, height: 28, fontSize: 12 } }}>
                      {notification.actors.map((actor) => (
                        <Avatar
                          key={actor.id}
                          src={actor.avatarUrl ?? undefined}
                          alt={actor.displayName ?? 'User'}
                        >
                          {(actor.displayName ?? 'U')[0].toUpperCase()}
                        </Avatar>
                      ))}
                    </AvatarGroup>
                  )}
                </ListItemAvatar>
                <ListItemText
                  primary={getNotificationText(notification)}
                  secondary={
                    <>
                      {notification.climbName && `on "${notification.climbName}" `}
                      {notification.commentBody && `${truncateComment(notification.commentBody, 80)} `}
                      {formatRelativeTime(notification.createdAt)}
                    </>
                  }
                  slotProps={{ primary: { variant: 'body2' } }}
                />
              </ListItem>
            ))}
          </List>

          {hasMore && (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
              <Button
                variant="outlined"
                onClick={handleLoadMore}
                disabled={isFetching}
              >
                {isFetching ? 'Loading...' : 'Load More'}
              </Button>
            </Box>
          )}
        </>
      )}
    </Box>
  )
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diffMs = now - then
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHrs = Math.floor(diffMin / 60)
  if (diffHrs < 24) return `${diffHrs}h ago`
  const diffDays = Math.floor(diffHrs / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return new Date(isoDate).toLocaleDateString()
}
