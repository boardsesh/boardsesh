import { createFileRoute } from '@tanstack/react-router'
import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Card from '@mui/material/Card'
import CardContent from '@mui/material/CardContent'
import Link from '@mui/material/Link'

export const Route = createFileRoute('/about')({
  ssr: false,
  component: AboutPage,
  head: () => ({
    meta: [{ title: 'About | Boardsesh' }],
  }),
})

function AboutPage() {
  return (
    <Box sx={{ maxWidth: 600, mx: 'auto', width: '100%', p: 2 }}>
      <Typography variant="h5" component="h1" gutterBottom>
        About Boardsesh
      </Typography>

      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Typography variant="body1" paragraph>
            Boardsesh is a companion app for standardized interactive climbing training boards
            (Kilter, Tension, and more). It adds missing functionality to boards using Aurora
            Climbing's software, including queue management, real-time collaborative sessions,
            and social features.
          </Typography>
          <Typography variant="body1" paragraph>
            Features include:
          </Typography>
          <Box component="ul" sx={{ pl: 2 }}>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              Browse and search climbs across all supported boards
            </Typography>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              Real-time party sessions with shared queues
            </Typography>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              Playlists to organize and share your favorite climbs
            </Typography>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              Social features: follow setters and climbers, comments, and activity feeds
            </Typography>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              Board LED control via Web Bluetooth
            </Typography>
          </Box>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <Typography variant="subtitle2" gutterBottom>
            Links
          </Typography>
          <Typography variant="body2">
            <Link
              href="https://github.com/boardsesh/boardsesh"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub Repository
            </Link>
          </Typography>
        </CardContent>
      </Card>
    </Box>
  )
}
