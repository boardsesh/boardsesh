import { createFileRoute, Link } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import CircularProgress from '@mui/material/CircularProgress'
import { useSession, signOut } from '@/lib/auth-client'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const { data: session, isPending } = useSession()

  return (
    <Container maxWidth="sm">
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          gap: 3,
          textAlign: 'center',
        }}
      >
        <Typography variant="h3" component="h1" fontWeight="bold">
          Boardsesh
        </Typography>
        <Typography variant="body1" color="text.secondary">
          Interactive climbing training board control
        </Typography>

        {isPending ? (
          <CircularProgress size={24} />
        ) : session?.user ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
            <Typography variant="body1">
              Signed in as <strong>{session.user.email}</strong>
            </Typography>
            {session.user.name && (
              <Typography variant="body2" color="text.secondary">
                {session.user.name}
              </Typography>
            )}
            <Button
              variant="outlined"
              onClick={() => {
                void signOut()
              }}
            >
              Sign Out
            </Button>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', gap: 2 }}>
            <Button
              component={Link}
              to="/auth/login"
              variant="contained"
              color="primary"
            >
              Sign In
            </Button>
            <Button
              component={Link}
              to="/auth/register"
              variant="outlined"
              color="primary"
            >
              Register
            </Button>
          </Box>
        )}
      </Box>
    </Container>
  )
}
