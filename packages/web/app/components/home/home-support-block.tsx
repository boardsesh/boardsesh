import 'server-only';
import React from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import GitHub from '@mui/icons-material/GitHub';
import { getServerTranslation } from '@/app/lib/i18n/server';
import LocaleLink from '@/app/components/i18n/locale-link';
import { PageSection, PageCard, Prose } from '@/app/components/ui/page-shell';
import { brandCtaSx } from '@/app/components/ui/brand-cta';
import styles from './home-support-block.module.css';

/**
 * "Boardsesh runs on climbers chipping in" — the last block before the footer.
 *
 * A server component: the ask and every link have to be in the first
 * server-rendered HTML, and none of it needs the browser.
 *
 * The copy is a legal constraint, not taste. It promises nothing in return for
 * money — no unlocks, no early access, no priority anything — and it names no
 * figure: no hosting cost, no revenue, no climber count. `donation-disclosure.test.ts`
 * in `@boardsesh/i18n` pins the perks vocabulary per locale. The four
 * non-monetary links reuse the `/support` page's own titles rather than
 * inventing a parallel set of keys.
 */

// Hoisted: brandCtaSx returns a plain object. The amber glow stays on the
// hero's one CTA — this block takes the plain filled violet.
const CHIP_IN_SX = brandCtaSx({ size: 'medium' });

const GITHUB_REPO_URL = 'https://github.com/boardsesh/boardsesh';
const GITHUB_ISSUES_URL = 'https://github.com/boardsesh/boardsesh/issues';
const LOCALE_CATALOGS_URL = 'https://github.com/boardsesh/boardsesh/tree/main/packages/shared/i18n/locales';
const DISCORD_URL = 'https://discord.gg/YXA8GsXfQK';

export default async function HomeSupportBlock() {
  const { t } = await getServerTranslation('marketing');

  const otherWays = [
    { id: 'bug', href: GITHUB_ISSUES_URL, label: t('support.otherWays.bug.title') },
    { id: 'translate', href: LOCALE_CATALOGS_URL, label: t('support.otherWays.translate.title') },
    { id: 'patch', href: GITHUB_REPO_URL, label: t('support.otherWays.patch.title') },
    { id: 'discord', href: DISCORD_URL, label: t('support.otherWays.discord.title') },
  ];

  return (
    <Box className={styles.block} data-testid="home-support-block">
      <PageCard className={styles.strip}>
        <Box>
          <Typography variant="body2" component="span" className={styles.eyebrow}>
            {t('home.support.eyebrow')}
          </Typography>
          <PageSection title={t('home.support.title')}>
            <Prose>{t('home.support.p1')}</Prose>
            <Prose>{t('home.support.p2')}</Prose>
            <Box className={styles.actions}>
              <Button variant="contained" sx={CHIP_IN_SX} component={LocaleLink} href="/support">
                {t('home.support.chipIn')}
              </Button>
              <Button
                variant="outlined"
                href={GITHUB_REPO_URL}
                target="_blank"
                rel="noopener noreferrer"
                startIcon={<GitHub />}
              >
                {t('home.support.source')}
              </Button>
            </Box>
          </PageSection>
        </Box>

        <PageCard variant="elevated" component="aside" padding="sm">
          <Typography variant="h5" component="h3" className={styles.asideTitle}>
            {t('home.support.otherWays')}
          </Typography>
          <Box component="ul" className={styles.asideList}>
            {otherWays.map((way) => (
              <Box component="li" key={way.id}>
                <MuiLink href={way.href} target="_blank" rel="noopener noreferrer" underline="hover">
                  {way.label}
                </MuiLink>
              </Box>
            ))}
          </Box>
        </PageCard>
      </PageCard>
    </Box>
  );
}
