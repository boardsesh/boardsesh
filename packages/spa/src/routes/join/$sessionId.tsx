import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect } from 'react'
import Box from '@mui/material/Box'
import CircularProgress from '@mui/material/CircularProgress'
import Typography from '@mui/material/Typography'

export const Route = createFileRoute('/join/$sessionId')({
  ssr: false,
  component: JoinSessionRedirect,
})

function JoinSessionRedirect() {
  const { sessionId } = Route.useParams()
  const navigate = useNavigate()

  useEffect(() => {
    void navigate({
      to: '/session/$sessionId',
      params: { sessionId },
      replace: true,
    })
  }, [navigate, sessionId])

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '100vh',
        gap: 2,
      }}
    >
      <CircularProgress />
      <Typography variant="body2" color="text.secondary">
        Joining session...
      </Typography>
    </Box>
  )
}
