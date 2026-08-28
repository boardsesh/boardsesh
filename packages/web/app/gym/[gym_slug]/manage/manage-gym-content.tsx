'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Container from '@mui/material/Container';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import MuiLink from '@mui/material/Link';
import ArrowBackOutlined from '@mui/icons-material/ArrowBackOutlined';
import type { TFunction } from 'i18next';
import type { Gym } from '@boardsesh/shared-schema';
import { gymManageTabViewed } from '@boardsesh/analytics';
import LocaleLink from '@/app/components/i18n/locale-link';
import { trackGymFunnelEvent } from '@/app/lib/gym-funnel-analytics';
import { useLocaleRouter, usePathnameWithoutLocale } from '@/app/lib/i18n/use-locale-router';
import { resolveGymRole, type GymRoleKind } from '@/app/lib/gym-role';
import { themeTokens } from '@/app/theme/theme-config';
import GymMemberManagement from '@/app/components/gym-entity/gym-member-management';
import { canManageGymBoards } from '@/app/components/gym-entity/manage/gym-board-permissions';
import GymBoardsTab from '@/app/components/gym-entity/manage/gym-boards-tab';
import KiosksTab from '@/app/components/gym-entity/manage/kiosks-tab';
import InsightsTab from '@/app/components/gym-entity/manage/insights-tab';
import BrandingTab from '@/app/components/gym-entity/manage/branding-tab';
import OverviewTab from '@/app/components/gym-entity/manage/overview-tab';
import ProfileTab from '@/app/components/gym-entity/manage/profile-tab';
import CommentsTab from '@/app/components/gym-entity/manage/comments-tab';
import GymSlugGuard from '@/app/components/gym-entity/manage/gym-slug-guard';
import ConfirmDialog from '@/app/components/gym-entity/manage/confirm-dialog';
import { decideManageNavigation, type ManageNavigation } from '@/app/components/gym-entity/manage/manage-nav-guard';

type ManageTab = 'overview' | 'kiosks' | 'insights' | 'branding' | 'profile' | 'boards' | 'members' | 'comments';
const VALID_TABS: ManageTab[] = [
  'overview',
  'kiosks',
  'insights',
  'branding',
  'profile',
  'boards',
  'members',
  'comments',
];
const DEFAULT_TAB: ManageTab = 'overview';

// Reuses the My Gyms role labels (common:myGyms.*) so the console header and the
// drawer name the viewer's standing the same way. Static-literal keys — the i18n
// linter forbids t(variable).
function roleChipLabel(t: TFunction, role: GymRoleKind): string {
  switch (role) {
    case 'owner':
      return t('common:myGyms.roleOwner');
    case 'admin':
      return t('common:myGyms.roleAdmin');
    case 'editor':
      return t('common:myGyms.roleEditor');
    case 'member':
      return t('common:myGyms.roleMember');
  }
}

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
  // The viewer's standing at this gym (owner/admin/editor), shown as a chip in
  // the header. Null for a community moderator who can edit via a community role
  // but holds no gym_members row — no gym-level standing to badge.
  const viewerRole = resolveGymRole(gym, currentUserId);

  const tabParam = searchParams.get('tab');
  const activeTab: ManageTab = VALID_TABS.includes(tabParam as ManageTab) ? (tabParam as ManageTab) : DEFAULT_TAB;

  // A completed tab switch unmounts the dirty tab; clear the flag so the new
  // tab doesn't inherit it (the unmounting tab's cleanup also reports false).
  useEffect(() => {
    setIsActiveTabDirty(false);
  }, [activeTab]);

  // One `Gym Manage Tab Viewed` per tab actually shown, mount included.
  //
  // Watching the RESOLVED tab rather than hooking handleTabChange is the whole
  // point: a `?tab=` deep link and a first mount are views that no tap handler
  // sees, and a tap the dirty-guard cancels is a tap that changed nothing. The
  // ref is what makes it once-per-view — an unrelated re-render (or StrictMode
  // re-running the effect against the same tab) must not count a second view.
  const lastTrackedTab = useRef<ManageTab | null>(null);
  useEffect(() => {
    if (lastTrackedTab.current === activeTab) return;
    lastTrackedTab.current = activeTab;
    trackGymFunnelEvent(gymManageTabViewed({ tab: activeTab }));
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

  // The Profile tab's form can rename the slug. When it does, the shell's
  // basePath still points at the old slug, so the next tab switch would push
  // `${oldSlug}?tab=X` and 404 (a renamed slug resolves to nothing). Reuse the
  // slug-guard's replace to move onto the new slug; otherwise just sync state.
  const handleProfileSaved = (updatedGym: Gym) => {
    if (updatedGym.slug && updatedGym.slug !== gym.slug) {
      handleSlugSet(updatedGym);
    } else {
      setGym(updatedGym);
    }
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

      <Box sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mb: 3 }}>
        <Typography variant="h4" component="h1" sx={{ fontWeight: themeTokens.typography.fontWeight.bold }}>
          {t('manage.title', { gymName: gym.name })}
        </Typography>
        {viewerRole && <Chip size="small" color="primary" label={roleChipLabel(t, viewerRole)} />}
      </Box>

      {!gym.slug && <GymSlugGuard gym={gym} onSlugSet={handleSlugSet} />}

      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}
      >
        <Tab value="overview" label={t('manage.tabs.overview')} sx={{ textTransform: 'none' }} />
        <Tab value="kiosks" label={t('manage.tabs.kiosks')} sx={{ textTransform: 'none' }} />
        <Tab value="insights" label={t('manage.tabs.insights')} sx={{ textTransform: 'none' }} />
        <Tab value="branding" label={t('manage.tabs.branding')} sx={{ textTransform: 'none' }} />
        <Tab value="profile" label={t('manage.tabs.profile')} sx={{ textTransform: 'none' }} />
        <Tab value="boards" label={t('manage.tabs.boards')} sx={{ textTransform: 'none' }} />
        <Tab value="members" label={t('manage.tabs.members')} sx={{ textTransform: 'none' }} />
        <Tab value="comments" label={t('manage.tabs.comments')} sx={{ textTransform: 'none' }} />
      </Tabs>

      {activeTab === 'overview' && <OverviewTab gym={gym} />}
      {activeTab === 'kiosks' && <KiosksTab gym={gym} onGymChange={setGym} onDirtyChange={setIsActiveTabDirty} />}
      {activeTab === 'insights' && <InsightsTab gym={gym} onGymChange={setGym} />}
      {activeTab === 'branding' && <BrandingTab gym={gym} onGymChange={setGym} onDirtyChange={setIsActiveTabDirty} />}
      {activeTab === 'profile' && (
        <ProfileTab gym={gym} onGymChange={handleProfileSaved} onDirtyChange={setIsActiveTabDirty} />
      )}
      {activeTab === 'boards' && <GymBoardsTab gym={gym} onGymChange={setGym} />}
      {activeTab === 'members' && (
        <GymMemberManagement
          gymUuid={gym.uuid}
          isOwnerOrAdmin={isOwnerOrAdmin}
          canGrantAccess={gym.canGrantAccess ?? false}
        />
      )}
      {activeTab === 'comments' && <CommentsTab gym={gym} />}

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
