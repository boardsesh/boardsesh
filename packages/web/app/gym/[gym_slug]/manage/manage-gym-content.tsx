'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import MuiLink from '@mui/material/Link';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import type { Gym } from '@boardsesh/shared-schema';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { themeTokens } from '@/app/theme/theme-config';
import GymMemberManagement from '@/app/components/gym-entity/gym-member-management';
import { canManageGymBoards } from '@/app/components/gym-entity/manage/gym-board-permissions';
import GymBoardsTab from '@/app/components/gym-entity/manage/gym-boards-tab';
import KiosksTab from '@/app/components/gym-entity/manage/kiosks-tab';
import BrandingTab from '@/app/components/gym-entity/manage/branding-tab';
import GymSlugGuard from '@/app/components/gym-entity/manage/gym-slug-guard';
import ConfirmDialog from '@/app/components/gym-entity/manage/confirm-dialog';
import { decideManageNavigation, type ManageNavigation } from '@/app/components/gym-entity/manage/manage-nav-guard';

type ManageTab = 'kiosks' | 'branding' | 'boards' | 'members';
const VALID_TABS: ManageTab[] = ['kiosks', 'branding', 'boards', 'members'];
const DEFAULT_TAB: ManageTab = 'kiosks';

export default function ManageGymContent({ initialGym }: { initialGym: Gym }) {
  const { t } = useTranslation('kiosk');
  const [gym, setGym] = useState<Gym>(initialGym);
  const searchParams = useSearchParams();
  const router = useLocaleRouter();
  const basePath = usePathnameWithoutLocale();
  const { data: session } = useSession();

  // Unsaved-edit guard: the active tab reports its dirty state via
  // GymManageTabProps.onDirtyChange; in-app navigations away from it (tab
  // switch, "Back to gym") hold behind a discard confirmation while dirty.
  // Browser back/refresh/close stays on the tabs' own beforeunload handlers.
  const [isActiveTabDirty, setIsActiveTabDirty] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<ManageNavigation | null>(null);

  const currentUserId = session?.user?.id ?? null;
  const isOwnerOrAdmin = canManageGymBoards(gym, currentUserId);

  const tabParam = searchParams.get('tab');
  const activeTab: ManageTab = VALID_TABS.includes(tabParam as ManageTab) ? (tabParam as ManageTab) : DEFAULT_TAB;

  // A completed tab switch unmounts the dirty tab; clear the flag so the new
  // tab doesn't inherit it (the unmounting tab's cleanup also reports false).
  useEffect(() => {
    setIsActiveTabDirty(false);
  }, [activeTab]);

  const performNavigation = useCallback(
    (navigation: ManageNavigation) => {
      if (navigation.kind === 'href') {
        router.push(navigation.href);
        return;
      }
      const params = new URLSearchParams(searchParams.toString());
      if (navigation.tab === DEFAULT_TAB) {
        params.delete('tab');
      } else {
        params.set('tab', navigation.tab);
      }
      const query = params.toString();
      router.push(query ? `${basePath}?${query}` : basePath, { scroll: false });
    },
    [router, searchParams, basePath],
  );

  const handleTabChange = (_event: React.SyntheticEvent, value: ManageTab) => {
    const decision = decideManageNavigation(isActiveTabDirty, { kind: 'tab', tab: value });
    if (decision.action === 'proceed') {
      performNavigation(decision.navigation);
    } else {
      setPendingNavigation(decision.pending);
    }
  };

  const handleSlugSet = (updatedGym: Gym) => {
    setGym(updatedGym);
    // Move to the canonical slug URL so kiosk/public links resolve from here on.
    const query = activeTab === DEFAULT_TAB ? '' : `?tab=${activeTab}`;
    router.replace(`/gym/${updatedGym.slug}/manage${query}`, { scroll: false });
  };

  return (
    <Container maxWidth="md" sx={{ py: 4, pt: 'calc(var(--global-header-height) + 32px)' }}>
      {gym.slug && (
        <Box sx={{ mb: 1.5 }}>
          <MuiLink
            component={LocaleLink}
            href={`/gym/${gym.slug}`}
            underline="hover"
            onClick={(event: React.MouseEvent) => {
              // Clean tab → let the real link navigate (keeps middle-click /
              // new-tab semantics). Dirty tab → hold it behind the confirm.
              const decision = decideManageNavigation(isActiveTabDirty, {
                kind: 'href',
                href: `/gym/${gym.slug}`,
              });
              if (decision.action === 'confirm') {
                event.preventDefault();
                setPendingNavigation(decision.pending);
              }
            }}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'var(--color-primary)' }}
          >
            <ArrowBackOutlined sx={{ fontSize: 16 }} />
            {t('manage.backToGym')}
          </MuiLink>
        </Box>
      )}

      <Typography variant="h4" component="h1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold, mb: 3 }}>
        {t('manage.title', { gymName: gym.name })}
      </Typography>

      {!gym.slug && <GymSlugGuard gym={gym} onSlugSet={handleSlugSet} />}

      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}
      >
        <Tab value="kiosks" label={t('manage.tabs.kiosks')} sx={{ textTransform: 'none' }} />
        <Tab value="branding" label={t('manage.tabs.branding')} sx={{ textTransform: 'none' }} />
        <Tab value="boards" label={t('manage.tabs.boards')} sx={{ textTransform: 'none' }} />
        <Tab value="members" label={t('manage.tabs.members')} sx={{ textTransform: 'none' }} />
      </Tabs>

      {activeTab === 'kiosks' && <KiosksTab gym={gym} onGymChange={setGym} onDirtyChange={setIsActiveTabDirty} />}
      {activeTab === 'branding' && <BrandingTab gym={gym} onGymChange={setGym} onDirtyChange={setIsActiveTabDirty} />}
      {activeTab === 'boards' && <GymBoardsTab gym={gym} onGymChange={setGym} />}
      {activeTab === 'members' && (
        <GymMemberManagement
          gymUuid={gym.uuid}
          isOwnerOrAdmin={isOwnerOrAdmin}
          canGrantAccess={gym.canGrantAccess ?? false}
        />
      )}

      <ConfirmDialog
        open={pendingNavigation !== null}
        title={t('manage.navGuard.title')}
        body={t('manage.navGuard.body')}
        confirmLabel={t('manage.navGuard.discard')}
        cancelLabel={t('manage.navGuard.stay')}
        onConfirm={() => {
          const confirmedNavigation = pendingNavigation;
          setPendingNavigation(null);
          setIsActiveTabDirty(false);
          if (confirmedNavigation) performNavigation(confirmedNavigation);
        }}
        onClose={() => setPendingNavigation(null)}
      />
    </Container>
  );
}
