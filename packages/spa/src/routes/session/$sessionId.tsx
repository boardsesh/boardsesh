import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import AvatarGroup from '@mui/material/AvatarGroup'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import { graphqlClient } from '@/lib/graphql-client'
import { SESSION, SESSION_SUMMARY } from '@/lib/graphql-queries'
import type { Session, SessionSummary } from '@/lib/types'

export const Route = createFileRoute('/session/$sessionId')({
  ssr: true,
  component: SessionPage,
  head: ({ params }) => ({
    meta: [
      { title: 'Session | Boardsesh' },
      { name: 'og:title', content: 'Climbing Session | Boardsesh' },
      { name: 'og:url', content: `/session/${params.sessionId}` },
      { name: 'og:description', content: 'Join this climbing session on Boardsesh' },
    ],
  }),
})

function SessionPage() {
  const { sessionId } = Route.useParams()

  const { data: session, isLoading, error } = useQuery({
    queryKey: ['session', sessionId],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        session: Session | null
      }>(SESSION, { sessionId })
      return result.session
    },
  })

  const { data: summary } = useQuery({
    queryKey: ['sessionSummary', sessionId],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        sessionSummary: SessionSummary | null
      }>(SESSION_SUMMARY, { sessionId })
      return result.sessionSummary
    },
    enabled: !!session,
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !session) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {error ? 'Failed to load session.' : 'Session not found.'}
        </Alert>
      </Box>
    )
  }

  const isEnded = !!session.endedAt

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', width: '100%', p: 2 }}>
      {/* Session header */}
      <Box sx={{ mb: 3 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography variant="h5" component="h1">
            {session.name ?? 'Climbing Session'}
          </Typography>
          <Chip
            label={isEnded ? 'Ended' : 'Active'}
            size="small"
            color={isEnded ? 'default' : 'success'}
          />
        </Box>
        {session.goal && (
          <Typography variant="body2" color="text.secondary">
            Goal: {session.goal}
          </Typography>
        )}
        <Typography variant="body2" color="text.secondary">
          Board: {session.boardPath}
        </Typography>
      </Box>

      {/* Participants */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Participants ({session.users.length})
          </Typography>
          <AvatarGroup max={8} sx={{ justifyContent: 'flex-start', mb: 1 }}>
            {session.users.map((user) => (
              <Avatar
                key={user.id}
                src={user.avatarUrl ?? undefined}
                alt={user.username}
                sx={{ width: 36, height: 36 }}
              >
                {user.username[0].toUpperCase()}
              </Avatar>
            ))}
          </AvatarGroup>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            {session.users.map((user) => (
              <Chip
                key={user.id}
                label={user.username}
                size="small"
                variant={user.isLeader ? 'filled' : 'outlined'}
                color={user.isLeader ? 'primary' : 'default'}
              />
            ))}
          </Box>
        </CardContent>
      </Card>

      {/* Session summary (if available) */}
      {summary && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Session Summary
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 2,
                mb: 2,
              }}
            >
              <StatItem label="Sends" value={String(summary.totalSends)} />
              <StatItem label="Attempts" value={String(summary.totalAttempts)} />
              {summary.durationMinutes != null && (
                <StatItem label="Duration" value={`${summary.durationMinutes}m`} />
              )}
            </Box>

            {summary.hardestClimb && (
              <>
                <Divider sx={{ my: 1 }} />
                <Typography variant="body2" color="text.secondary">
                  Hardest send: {summary.hardestClimb.climbName} ({summary.hardestClimb.grade})
                </Typography>
              </>
            )}

            {summary.gradeDistribution.length > 0 && (
              <>
                <Divider sx={{ my: 1 }} />
                <Typography variant="caption" color="text.secondary">
                  Grades
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                  {summary.gradeDistribution.map((gd) => (
                    <Chip
                      key={gd.grade}
                      label={`${gd.grade}: ${gd.count}`}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Box>
              </>
            )}

            {summary.participants.length > 0 && (
              <>
                <Divider sx={{ my: 1 }} />
                <Typography variant="caption" color="text.secondary">
                  Participants
                </Typography>
                {summary.participants.map((p) => (
                  <Box
                    key={p.userId}
                    sx={{ display: 'flex', justifyContent: 'space-between', py: 0.5 }}
                  >
                    <Typography variant="body2">
                      {p.displayName ?? 'Anonymous'}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">
                      {p.sends} sends / {p.attempts} attempts
                    </Typography>
                  </Box>
                ))}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  )
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ textAlign: 'center' }}>
      <Typography variant="h6">{value}</Typography>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
    </Box>
  )
}
