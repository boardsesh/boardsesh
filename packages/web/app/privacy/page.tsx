import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Link from '@mui/material/Link';
import { createPageMetadata } from '@/app/lib/seo/metadata';

export const metadata = createPageMetadata({
  title: 'Privacy Policy',
  description: 'Boardsesh privacy policy - how we handle your data.',
  path: '/privacy',
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 4 }}>
      <Typography variant="h5" component="h2" sx={{ mb: 1.5, fontWeight: 600 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="body1" sx={{ mb: 1.5, lineHeight: 1.7 }}>
      {children}
    </Typography>
  );
}

export default function PrivacyPolicyPage() {
  return (
    <Container maxWidth="md" sx={{ py: 6 }}>
      <Typography variant="h3" component="h1" sx={{ mb: 1, fontWeight: 700 }}>
        Privacy Policy
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 4 }}>
        Last updated: March 2026
      </Typography>
      <Divider sx={{ mb: 4 }} />

      <Paragraph>
        Boardsesh is an open-source app for controlling climbing training boards (Kilter, Tension,
        MoonBoard) over Bluetooth. This policy explains what data we collect, why, and what we do
        with it.
      </Paragraph>
      <Paragraph>
        The short version: we collect only what we need to make the app work. We do not sell your
        data, we do not run ads, and we do not use third-party tracking.
      </Paragraph>

      <Section title="What we collect">
        <Paragraph>
          <strong>Account information.</strong> When you create an account, we store your email
          address and username. Your email is used for authentication. Your username is displayed on
          your profile and visible to other users in Party Mode sessions and social features.
        </Paragraph>
        <Paragraph>
          <strong>Climb activity.</strong> When you log a send or attempt, we store the climb
          details, grade, date, and any notes you add. This powers your logbook and progression
          tracking.
        </Paragraph>
        <Paragraph>
          <strong>Location.</strong> If you grant location permission, we use your approximate
          location to help you discover nearby Party Mode sessions. We do not track your location in
          the background or store location history.
        </Paragraph>
        <Paragraph>
          <strong>Analytics.</strong> We use Vercel Analytics to collect anonymous page view and
          performance data. This helps us understand which features are used and where the app is
          slow. This data is not linked to your account.
        </Paragraph>
      </Section>

      <Section title="Bluetooth">
        <Paragraph>
          Boardsesh uses Bluetooth Low Energy (BLE) to connect to your climbing board&apos;s LED
          controller. The Bluetooth connection is used exclusively to send hold lighting commands to
          the board. No personal data is transmitted over Bluetooth. The app does not read data from
          the board beyond basic device identification during pairing.
        </Paragraph>
      </Section>

      <Section title="Location data">
        <Paragraph>
          Location access is optional. When granted, it is used for one purpose: making your Party
          Mode session discoverable to nearby climbers. Your location is shared with the server only
          while a Party Mode session is active. We do not store your location history, build a
          location profile, or share location data with anyone outside of the party session
          discovery feature.
        </Paragraph>
        <Paragraph>
          You can revoke location permission at any time in your device settings. The app works
          fully without it.
        </Paragraph>
      </Section>

      <Section title="Third-party services">
        <Paragraph>
          <strong>Vercel.</strong> We use Vercel for hosting and analytics. Vercel processes
          requests to serve the app and collects anonymous usage metrics. See{' '}
          <Link href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener">
            Vercel&apos;s privacy policy
          </Link>
          .
        </Paragraph>
        <Paragraph>
          <strong>Aurora Climbing API.</strong> If you link your Aurora Climbing account (used by
          Kilter and Tension boards), we sync your climb data with Aurora&apos;s servers so your
          logbook stays consistent across apps. This sync only happens when you initiate it. See{' '}
          <Link href="https://auroraclimbing.com" target="_blank" rel="noopener">
            Aurora Climbing
          </Link>{' '}
          for their data practices.
        </Paragraph>
      </Section>

      <Section title="Data sharing">
        <Paragraph>
          We do not sell your data. We do not run ads. We do not share your information with
          third-party marketers or data brokers. The only data shared externally is what is described
          above (Vercel hosting/analytics, Aurora Climbing sync when you opt in).
        </Paragraph>
        <Paragraph>
          Other Boardsesh users can see your username, profile, and logged climbs if you
          participate in social features like Party Mode. This is visible in the app and is part of
          how the product works.
        </Paragraph>
      </Section>

      <Section title="Data retention">
        <Paragraph>
          We keep your account data and climb history for as long as your account is active. If you
          stop using Boardsesh, your data stays until you delete your account.
        </Paragraph>
      </Section>

      <Section title="Account deletion">
        <Paragraph>
          You can delete your account from the Settings page in the app. Deleting your account
          permanently removes your email, username, logbook entries, queue data, and party session
          history from our servers. This action cannot be undone.
        </Paragraph>
      </Section>

      <Section title="Children">
        <Paragraph>
          Boardsesh is not directed at children under 13. We do not knowingly collect personal
          information from children under 13. If you believe a child under 13 has created an
          account, contact us and we will delete it.
        </Paragraph>
      </Section>

      <Section title="Changes to this policy">
        <Paragraph>
          If we change this privacy policy, we will update this page with the new text and the
          &quot;last updated&quot; date. For significant changes, we may also notify you in the app.
        </Paragraph>
      </Section>

      <Section title="Contact">
        <Paragraph>
          Questions about this policy or your data? Email us at{' '}
          <Link href="mailto:support@boardsesh.com">support@boardsesh.com</Link>.
        </Paragraph>
        <Paragraph>
          Boardsesh is open source. You can see exactly what data the app collects and how it is
          processed by reading the source code on{' '}
          <Link href="https://github.com/boardsesh/boardsesh" target="_blank" rel="noopener">
            GitHub
          </Link>
          .
        </Paragraph>
      </Section>
    </Container>
  );
}
