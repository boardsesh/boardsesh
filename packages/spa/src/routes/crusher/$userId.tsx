import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Avatar from '@mui/material/Avatar'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Chip from '@mui/material/Chip'
import { graphqlClient } from '@/lib/graphql-client'
import { PUBLIC_PROFILE, USER_PROFILE_STATS } from '@/lib/graphql-queries'
import type { PublicUserProfile, ProfileStats } from '@/lib/types'

export const Route = createFileRoute('/crusher/$userId')({
  ssr: true,
  component: CrusherProfilePage,
  head: ({ params }) => ({
    meta: [
      { title: 'Climber Profile | Boardsesh' },
      { name: 'og:title', content: 'Climber Profile | Boardsesh' },
      { name: 'og:url', content: `/crusher/${params.userId}` },
      { name: 'og:description', content: 'View climbing profile and stats on Boardsesh' },
    ],
  }),
})

function CrusherProfilePage() {
  const { userId } = Route.useParams()

  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['publicProfile', userId],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        publicProfile: PublicUserProfile | null
      }>(PUBLIC_PROFILE, { userId })
      return result.publicProfile
    },
  })

  const { data: stats } = useQuery({
    queryKey: ['userProfileStats', userId],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        userProfileStats: ProfileStats
      }>(USER_PROFILE_STATS, { userId })
      return result.userProfileStats
    },
    enabled: !!profile,
  })

  if (isLoading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress />
      </Box>
    )
  }

  if (error || !profile) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto' }}>
        <Alert severity="error">
          {error ? 'Failed to load profile.' : 'User not found.'}
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', width: '100%', p: 2 }}>
      {/* Profile header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        <Avatar
          src={profile.avatarUrl ?? undefined}
          alt={profile.displayName ?? 'User'}
          sx={{ width: 72, height: 72 }}
        >
          {(profile.displayName ?? 'U')[0].toUpperCase()}
        </Avatar>
        <Box>
          <Typography variant="h5" component="h1">
            {profile.displayName ?? 'Anonymous'}
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, mt: 0.5 }}>
            <Typography variant="body2" color="text.secondary">
              {profile.followerCount} followers
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {profile.followingCount} following
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Stats */}
      {stats && (
        <Card sx={{ mb: 2 }}>
          <CardContent>
            <Typography variant="subtitle2" gutterBottom>
              Climbing Stats
            </Typography>
            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 1fr)',
                gap: 2,
                mb: 2,
              }}
            >
              <StatItem label="Sends" value={String(stats.totalSends)} />
              <StatItem label="Attempts" value={String(stats.totalAttempts)} />
              <StatItem label="Distinct Climbs" value={String(stats.distinctClimbsSent)} />
            </Box>

            {stats.gradeCounts.length > 0 && (
              <>
                <Typography variant="subtitle2" gutterBottom sx={{ mt: 2 }}>
                  Grade Distribution
                </Typography>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
                  {stats.gradeCounts.map((gc) => (
                    <Chip
                      key={gc.grade}
                      label={`${gc.grade}: ${gc.count}`}
                      size="small"
                      variant="outlined"
                    />
                  ))}
                </Box>
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
