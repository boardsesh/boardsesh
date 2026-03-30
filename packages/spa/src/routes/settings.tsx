import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import CircularProgress from '@mui/material/CircularProgress'
import Alert from '@mui/material/Alert'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Avatar from '@mui/material/Avatar'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import Button from '@mui/material/Button'
import LogoutIcon from '@mui/icons-material/Logout'
import { graphqlClient } from '@/lib/graphql-client'
import { PROFILE, AURORA_CREDENTIALS } from '@/lib/graphql-queries'
import { signOut } from '@/lib/auth-client'
import type { UserProfile, AuroraCredentialStatus } from '@/lib/types'

export const Route = createFileRoute('/settings')({
  ssr: false,
  component: SettingsPage,
  head: () => ({
    meta: [{ title: 'Settings | Boardsesh' }],
  }),
})

function SettingsPage() {
  const { data: profile, isLoading, error } = useQuery({
    queryKey: ['profile'],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        profile: UserProfile | null
      }>(PROFILE)
      return result.profile
    },
  })

  const { data: credentials } = useQuery({
    queryKey: ['auroraCredentials'],
    queryFn: async () => {
      const result = await graphqlClient.request<{
        auroraCredentials: AuroraCredentialStatus[]
      }>(AURORA_CREDENTIALS)
      return result.auroraCredentials
    },
    enabled: !!profile,
  })

  const handleSignOut = () => {
    void signOut()
  }

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
          {error ? 'Failed to load settings.' : 'Please log in to view settings.'}
        </Alert>
      </Box>
    )
  }

  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', width: '100%', p: 2 }}>
      <Typography variant="h5" component="h1" gutterBottom>
        Settings
      </Typography>

      {/* Profile section */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Profile
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Avatar
              src={profile.avatarUrl ?? undefined}
              alt={profile.displayName ?? 'User'}
              sx={{ width: 56, height: 56 }}
            >
              {(profile.displayName ?? profile.email[0]).toUpperCase()}
            </Avatar>
            <Box>
              <Typography variant="body1" fontWeight="medium">
                {profile.displayName ?? 'No display name'}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {profile.email}
              </Typography>
            </Box>
          </Box>
        </CardContent>
      </Card>

      {/* Aurora credentials */}
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Aurora Board Accounts
          </Typography>
          {credentials && credentials.length > 0 ? (
            credentials.map((cred) => (
              <Box key={cred.boardType} sx={{ py: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="body2" fontWeight="medium">
                      {cred.boardType}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {cred.username}
                      {cred.syncedAt && ` - synced ${new Date(cred.syncedAt).toLocaleDateString()}`}
                    </Typography>
                  </Box>
                  <Chip
                    label={cred.hasToken ? 'Connected' : 'Not connected'}
                    size="small"
                    color={cred.hasToken ? 'success' : 'default'}
                    variant="outlined"
                  />
                </Box>
                <Divider sx={{ mt: 1 }} />
              </Box>
            ))
          ) : (
            <Typography variant="body2" color="text.secondary">
              No Aurora accounts linked yet.
            </Typography>
          )}
        </CardContent>
      </Card>

      {/* Sign out */}
      <Button
        variant="outlined"
        color="error"
        startIcon={<LogoutIcon />}
        onClick={handleSignOut}
        fullWidth
      >
        Sign Out
      </Button>
    </Box>
  )
}
