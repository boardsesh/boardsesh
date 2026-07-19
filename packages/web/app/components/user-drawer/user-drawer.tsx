'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import MuiAvatar from '@mui/material/Avatar';
import MuiTypography from '@mui/material/Typography';
import MuiButton from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import LogoutOutlined from '@mui/icons-material/LogoutOutlined';
import LoginOutlined from '@mui/icons-material/LoginOutlined';
import HelpOutlineOutlined from '@mui/icons-material/HelpOutlineOutlined';
import InfoOutlined from '@mui/icons-material/InfoOutlined';
import StarBorderOutlined from '@mui/icons-material/StarBorderOutlined';
import BugReportOutlined from '@mui/icons-material/BugReportOutlined';
import GpsFixedOutlined from '@mui/icons-material/GpsFixedOutlined';
import LocalOfferOutlined from '@mui/icons-material/LocalOfferOutlined';
import SwapHorizOutlined from '@mui/icons-material/SwapHorizOutlined';
import HistoryOutlined from '@mui/icons-material/HistoryOutlined';
import PlayCircleOutlineOutlined from '@mui/icons-material/PlayCircleOutlineOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import AccountTreeOutlined from '@mui/icons-material/AccountTreeOutlined';
import FactCheckOutlined from '@mui/icons-material/FactCheckOutlined';

import { useSession } from 'next-auth/react';
import { useColorMode } from '@/app/hooks/use-color-mode';
import { usePathname } from 'next/navigation';
import LocaleLink from '@/app/components/i18n/locale-link';
import { useLocaleRouter } from '@/app/lib/i18n/use-locale-router';
import {
  getPlaylistsBasePath,
  constructBoardSlugListUrl,
  constructClimbListWithSlugs,
  tryConstructSlugListUrl,
} from '@/app/lib/url-utils';
import { getDefaultAngleForBoard } from '@/app/lib/board-config-for-playlist';
import DashboardOutlined from '@mui/icons-material/DashboardOutlined';
import FitnessCenterOutlined from '@mui/icons-material/FitnessCenterOutlined';
import BuildOutlined from '@mui/icons-material/BuildOutlined';
import DeveloperBoardOutlined from '@mui/icons-material/DeveloperBoardOutlined';
import SwipeableDrawer from '../swipeable-drawer/swipeable-drawer';
import CompactLanguageSwitcher from '@/app/components/i18n/compact-language-switcher';
import DevUrlDialog from '../dev-url-dialog/dev-url-dialog';
import { useDevUrl } from '@/app/lib/dev-url';
import { useAuthModal } from '@/app/components/providers/auth-modal-provider';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { guardedNextAuthSignOut } from '@/app/lib/auth/nextauth-cookie-fetch-lock';
import { HoldClassificationWizard } from '../hold-classification';
import { FeedbackDialog } from '../feedback/feedback-dialog';
import { BugReportDialog } from '../feedback/bug-report-dialog';
import { StoreReviewPromptDialog } from '../feedback/store-review-prompt-dialog';
import BoardDiscoveryScroll from '../board-scroll/board-discovery-scroll';
import BoardSelectorDrawer from '../board-selector-drawer/board-selector-drawer';
import MyBoardsDrawer from '../my-boards-drawer/my-boards-drawer';
import MyGymsDrawer from '../my-gyms-drawer/my-gyms-drawer';
import type { BoardConfigData } from '@/app/lib/server-board-configs';
import type { BoardDetails, BoardName, BoardRouteIdentity } from '@/app/lib/types';
import { SUPPORTED_BOARDS } from '@/app/lib/board-data';
import type { UserBoard, PopularBoardConfig } from '@boardsesh/shared-schema';
import { useBoardSwitchGuard } from '@/app/components/board-lock/use-board-switch-guard';
import { track } from '@/app/lib/analytics';
import {
  type StoredSession,
  getRecentSessions,
  formatRelativeTime,
  extractBoardName,
} from '@/app/lib/session-history-db';
import styles from './user-drawer.module.css';

function asBoardName(value: string): BoardName | null {
  return (SUPPORTED_BOARDS as readonly string[]).includes(value) ? (value as BoardName) : null;
}

type UserDrawerProps = {
  boardDetails?: BoardDetails | null;
  angle?: number;
  boardConfigs?: BoardConfigData;
};

type DevMetadata = {
  branchName: string | null;
  qaNotes: string | null;
  qaNotesFilePath: string | null;
};

export default function UserDrawer({ boardDetails, boardConfigs }: UserDrawerProps) {
  const { t } = useTranslation('common');
  const { data: session } = useSession();
  const router = useLocaleRouter();
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);
  const [drawerRendered, setDrawerRendered] = useState(false);
  const { openAuthModal } = useAuthModal();
  const { showMessage } = useSnackbar();
  const [showHoldClassification, setShowHoldClassification] = useState(false);
  const [showBoardSelector, setShowBoardSelector] = useState(false);
  const [boardSelectorRendered, setBoardSelectorRendered] = useState(false);
  const [showCustomBoard, setShowCustomBoard] = useState(false);
  const [customBoardRendered, setCustomBoardRendered] = useState(false);
  const [showMyBoards, setShowMyBoards] = useState(false);
  const [myBoardsRendered, setMyBoardsRendered] = useState(false);
  const [showMyGyms, setShowMyGyms] = useState(false);
  const [myGymsRendered, setMyGymsRendered] = useState(false);
  const [recentSessions, setRecentSessions] = useState<StoredSession[]>([]);
  const [showDevUrl, setShowDevUrl] = useState(false);
  const { isAvailable: devUrlAvailable } = useDevUrl();
  const [showRating, setShowRating] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  const [showStoreReviewPrompt, setShowStoreReviewPrompt] = useState(false);
  const [devMetadata, setDevMetadata] = useState<DevMetadata | null>(null);

  const { mode, toggleMode } = useColorMode();
  const isMoonboard = boardDetails?.board_name === 'moonboard';
  const guardBoardSwitch = useBoardSwitchGuard();

  // Load recent sessions when drawer opens
  useEffect(() => {
    if (isOpen) {
      getRecentSessions()
        .then(setRecentSessions)
        .catch(() => {
          // IndexedDB may be unavailable (e.g. private browsing).
          // Silently fall back to an empty list — the section simply won't render.
          setRecentSessions([]);
        });
    }
  }, [isOpen]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development' || !isOpen || devMetadata) return;

    const controller = new AbortController();
    fetch('/api/internal/dev-metadata', { cache: 'no-store', signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((metadata: DevMetadata | null) => {
        if (!metadata) return;
        setDevMetadata(metadata);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setDevMetadata({ branchName: null, qaNotes: null, qaNotesFilePath: null });
        }
      });

    return () => controller.abort();
  }, [isOpen, devMetadata]);

  const handleClose = () => setIsOpen(false);
  const handleDrawerTransitionEnd = useCallback((open: boolean) => {
    if (!open) setDrawerRendered(false);
  }, []);
  const handleBoardSelectorTransitionEnd = useCallback((open: boolean) => {
    if (!open) setBoardSelectorRendered(false);
  }, []);
  const handleCustomBoardTransitionEnd = useCallback((open: boolean) => {
    if (!open) setCustomBoardRendered(false);
  }, []);
  const handleMyBoardsTransitionEnd = useCallback((open: boolean) => {
    if (!open) setMyBoardsRendered(false);
  }, []);
  const handleMyGymsTransitionEnd = useCallback((open: boolean) => {
    if (!open) setMyGymsRendered(false);
  }, []);

  const handleChangeBoardClick = useCallback(
    (board: UserBoard) => {
      if (!board.slug) return;
      const boardName = asBoardName(board.boardType);
      const navigate = () => {
        router.push(constructBoardSlugListUrl(board.slug, board.angle));
        setShowBoardSelector(false);
      };
      if (!boardName) {
        navigate();
        return;
      }
      const target: BoardRouteIdentity = {
        board_name: boardName,
        layout_id: board.layoutId,
        size_id: board.sizeId,
        set_ids: board.setIds ? board.setIds.split(',').map(Number).filter(Number.isFinite) : [],
      };
      guardBoardSwitch(target, navigate);
    },
    [router, guardBoardSwitch],
  );

  const handleChangeConfigClick = useCallback(
    (config: PopularBoardConfig) => {
      const angle = getDefaultAngleForBoard(config.boardType);
      let url: string;
      if (config.layoutName && config.sizeName && config.setNames.length > 0) {
        url = constructClimbListWithSlugs(
          config.boardType,
          config.layoutName,
          config.sizeName,
          config.sizeDescription ?? undefined,
          config.setNames,
          angle,
        );
      } else {
        const setIds = config.setIds.join(',');
        url =
          tryConstructSlugListUrl(config.boardType, config.layoutId, config.sizeId, config.setIds, angle) ??
          `/${config.boardType}/${config.layoutId}/${config.sizeId}/${setIds}/${angle}/list`;
      }
      const navigate = () => {
        router.push(url);
        setShowBoardSelector(false);
      };
      const boardName = asBoardName(config.boardType);
      if (!boardName) {
        navigate();
        return;
      }
      const target: BoardRouteIdentity = {
        board_name: boardName,
        layout_id: config.layoutId,
        size_id: config.sizeId,
        set_ids: config.setIds,
      };
      guardBoardSwitch(target, navigate);
    },
    [router, guardBoardSwitch],
  );

  const handleSignOut = () => {
    if (!session?.user.id || !session.authSessionId) {
      showMessage(t('userDrawer.logoutError'), 'error');
      return;
    }
    track('Logout', { method: 'manual' });
    void guardedNextAuthSignOut({
      userId: session.user.id,
      authSessionId: session.authSessionId,
    }).catch((error: unknown) => {
      console.error('Sign out error:', error);
      showMessage(t('userDrawer.logoutError'), 'error');
    });
    handleClose();
  };

  const handleResumeSession = (storedSession: StoredSession) => {
    const url = new URL(storedSession.boardPath, window.location.origin);
    url.searchParams.set('session', storedSession.id);
    router.push(url.pathname + url.search);
    handleClose();
  };

  const playlistsUrl = getPlaylistsBasePath(pathname);

  const userAvatar = session?.user?.image ?? undefined;
  const userName = session?.user?.name;
  const userEmail = session?.user?.email;
  const avatarClass = session?.user ? styles.avatarLoggedIn : styles.avatarLoggedOut;

  return (
    <>
      <IconButton
        onClick={() => {
          setDrawerRendered(true);
          setIsOpen(true);
        }}
        aria-label={t('ariaLabels.userMenu')}
        className={styles.avatarButton}
      >
        <MuiAvatar sx={{ width: 28, height: 28 }} src={userAvatar} className={avatarClass}>
          {!userAvatar ? <PersonOutlined /> : null}
        </MuiAvatar>
      </IconButton>

      {drawerRendered && (
        <SwipeableDrawer
          placement="left"
          open={isOpen}
          onClose={handleClose}
          onTransitionEnd={handleDrawerTransitionEnd}
          width={300}
          title={null}
        >
          <div className={styles.drawerBody}>
            {/* Profile section */}
            <div className={styles.profileSection}>
              {session?.user ? (
                <>
                  <MuiAvatar
                    component={LocaleLink}
                    href={`/profile/${session.user.id}`}
                    onClick={handleClose}
                    sx={{ width: 64, height: 64, cursor: 'pointer' }}
                    src={userAvatar}
                    className={avatarClass}
                  >
                    {!userAvatar ? <PersonOutlined /> : null}
                  </MuiAvatar>
                  {userName && (
                    <MuiTypography variant="body2" component="span" fontWeight={600} className={styles.userName}>
                      {userName}
                    </MuiTypography>
                  )}
                  {userEmail && (
                    <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.userEmail}>
                      {userEmail}
                    </MuiTypography>
                  )}
                </>
              ) : (
                <>
                  <MuiAvatar sx={{ width: 64, height: 64 }} src={userAvatar} className={avatarClass}>
                    {!userAvatar ? <PersonOutlined /> : null}
                  </MuiAvatar>
                  <MuiButton
                    variant="contained"
                    startIcon={<LoginOutlined />}
                    onClick={() => {
                      handleClose();
                      openAuthModal({
                        title: t('userDrawer.signInModalTitle'),
                        description: t('userDrawer.signInModalDescription'),
                      });
                    }}
                  >
                    {t('userDrawer.signIn')}
                  </MuiButton>
                </>
              )}
            </div>

            <div className={styles.divider} />

            {/* Navigation section */}
            <nav>
              <button
                type="button"
                className={styles.menuItem}
                onClick={() => {
                  handleClose();
                  setBoardSelectorRendered(true);
                  setShowBoardSelector(true);
                }}
              >
                <span className={styles.menuItemIcon}>
                  <SwapHorizOutlined />
                </span>
                <span className={styles.menuItemLabel}>{t('userDrawer.changeBoard')}</span>
              </button>

              {session?.user && (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    handleClose();
                    setMyBoardsRendered(true);
                    setShowMyBoards(true);
                  }}
                >
                  <span className={styles.menuItemIcon}>
                    <DashboardOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('myBoards.title')}</span>
                </button>
              )}

              {session?.user && (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    handleClose();
                    setMyGymsRendered(true);
                    setShowMyGyms(true);
                  }}
                >
                  <span className={styles.menuItemIcon}>
                    <FitnessCenterOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('myGyms.title')}</span>
                </button>
              )}

              <LocaleLink href="/settings" className={styles.menuItem} onClick={handleClose}>
                <span className={styles.menuItemIcon}>
                  <SettingsOutlined />
                </span>
                <span className={styles.menuItemLabel}>{t('ariaLabels.settings')}</span>
              </LocaleLink>

              {devUrlAvailable && (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    handleClose();
                    setShowDevUrl(true);
                  }}
                >
                  <span className={styles.menuItemIcon}>
                    <BuildOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('userDrawer.devUrl')}</span>
                </button>
              )}

              {process.env.NODE_ENV === 'development' && (
                <LocaleLink href="/development" className={styles.menuItem} onClick={handleClose}>
                  <span className={styles.menuItemIcon}>
                    <DeveloperBoardOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('userDrawer.development')}</span>
                </LocaleLink>
              )}

              {process.env.NODE_ENV === 'development' &&
                (devMetadata?.branchName || devMetadata?.qaNotes || devMetadata?.qaNotesFilePath) && (
                  <>
                    <div className={styles.divider} />
                    <MuiTypography
                      variant="body2"
                      component="span"
                      color="text.secondary"
                      className={styles.sectionLabel}
                    >
                      {t('userDrawer.devBuild')}
                    </MuiTypography>
                    <div className={styles.devMetadataPanel}>
                      {devMetadata.branchName && (
                        <div className={styles.devMetadataRow}>
                          <AccountTreeOutlined className={styles.devMetadataIcon} />
                          <div className={styles.devMetadataText}>
                            <span className={styles.devMetadataLabel}>{t('userDrawer.branch')}</span>
                            <span className={styles.devMetadataValue}>{devMetadata.branchName}</span>
                          </div>
                        </div>
                      )}

                      <div className={styles.devMetadataRow}>
                        <FactCheckOutlined className={styles.devMetadataIcon} />
                        <div className={styles.devMetadataText}>
                          <span className={styles.devMetadataLabel}>{t('userDrawer.qaNotes')}</span>
                          {devMetadata.qaNotesFilePath && (
                            <span className={styles.devMetadataFile}>{devMetadata.qaNotesFilePath}</span>
                          )}
                        </div>
                      </div>

                      {devMetadata.qaNotes ? (
                        <pre className={styles.qaNotes}>{devMetadata.qaNotes}</pre>
                      ) : (
                        <span className={styles.qaNotesEmpty}>{t('userDrawer.qaNotesEmpty')}</span>
                      )}
                    </div>
                  </>
                )}

              {boardDetails && !isMoonboard && (
                <button
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    handleClose();
                    setShowHoldClassification(true);
                  }}
                >
                  <span className={styles.menuItemIcon}>
                    <GpsFixedOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('userDrawer.classifyHolds')}</span>
                </button>
              )}

              <LocaleLink href={playlistsUrl} className={styles.menuItem} onClick={handleClose}>
                <span className={styles.menuItemIcon}>
                  <LocalOfferOutlined />
                </span>
                <span className={styles.menuItemLabel}>{t('userDrawer.myPlaylists')}</span>
              </LocaleLink>
            </nav>

            {/* Recents section */}
            {recentSessions.length > 0 && (
              <>
                <div className={styles.divider} />
                <MuiTypography variant="body2" component="span" color="text.secondary" className={styles.sectionLabel}>
                  {t('userDrawer.recentSessions')}
                </MuiTypography>
                {recentSessions.slice(0, 5).map((storedSession) => (
                  <button
                    type="button"
                    key={storedSession.id}
                    className={styles.recentItem}
                    onClick={() => handleResumeSession(storedSession)}
                  >
                    <HistoryOutlined className={styles.recentItemIcon} />
                    <div className={styles.recentItemInfo}>
                      <div className={styles.recentItemName}>
                        {storedSession.name || `${extractBoardName(storedSession.boardPath)} Session`}
                      </div>
                      <div className={styles.recentItemMeta}>
                        {extractBoardName(storedSession.boardPath)}
                        {storedSession.participantCount !== undefined && storedSession.participantCount > 0 && (
                          <>
                            {' '}
                            <GroupOutlined /> {storedSession.participantCount}
                          </>
                        )}{' '}
                        {formatRelativeTime(storedSession.lastActivity || storedSession.createdAt)}
                      </div>
                    </div>
                    <PlayCircleOutlineOutlined className={styles.recentItemAction} />
                  </button>
                ))}
              </>
            )}

            <div className={styles.divider} />

            {/* Help/About section */}
            <LocaleLink href="/help" className={styles.menuItem} onClick={handleClose}>
              <span className={styles.menuItemIcon}>
                <HelpOutlineOutlined />
              </span>
              <span className={styles.menuItemLabel}>{t('userDrawer.help')}</span>
            </LocaleLink>

            <LocaleLink href="/about" className={styles.menuItem} onClick={handleClose}>
              <span className={styles.menuItemIcon}>
                <InfoOutlined />
              </span>
              <span className={styles.menuItemLabel}>{t('userDrawer.about')}</span>
            </LocaleLink>

            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                handleClose();
                setShowRating(true);
              }}
            >
              <span className={styles.menuItemIcon}>
                <StarBorderOutlined />
              </span>
              <span className={styles.menuItemLabel}>{t('userDrawer.rateBoardsesh')}</span>
            </button>

            <button
              type="button"
              className={styles.menuItem}
              onClick={() => {
                handleClose();
                setShowBugReport(true);
              }}
            >
              <span className={styles.menuItemIcon}>
                <BugReportOutlined />
              </span>
              <span className={styles.menuItemLabel}>{t('userDrawer.reportBug')}</span>
            </button>

            {/* Logout */}
            {session?.user && (
              <>
                <div className={styles.divider} />
                <button type="button" className={`${styles.menuItem} ${styles.dangerItem}`} onClick={handleSignOut}>
                  <span className={styles.menuItemIcon}>
                    <LogoutOutlined />
                  </span>
                  <span className={styles.menuItemLabel}>{t('userDrawer.logout')}</span>
                </button>
              </>
            )}

            {/* Spacer to push toggle to bottom */}
            <div className={styles.bottomSpacer} />

            {/* Sun/Moon toggle + language switcher */}
            <div className={styles.themeToggleContainer}>
              <div
                className={styles.themeToggle}
                onClick={toggleMode}
                role="button"
                tabIndex={0}
                aria-label={t('ariaLabels.toggleDarkMode')}
              >
                <div className={`${styles.themeToggleThumb} ${mode === 'dark' ? styles.themeToggleThumbDark : ''}`} />
                <div
                  className={`${styles.themeToggleOption} ${mode === 'light' ? styles.themeToggleOptionActive : ''}`}
                >
                  <LightModeOutlined sx={{ fontSize: 16 }} />
                </div>
                <div className={`${styles.themeToggleOption} ${mode === 'dark' ? styles.themeToggleOptionActive : ''}`}>
                  <DarkModeOutlined sx={{ fontSize: 16 }} />
                </div>
              </div>
              <CompactLanguageSwitcher />
            </div>
          </div>
        </SwipeableDrawer>
      )}

      {boardDetails && (
        <HoldClassificationWizard
          open={showHoldClassification}
          onClose={() => setShowHoldClassification(false)}
          boardDetails={boardDetails}
        />
      )}

      {boardSelectorRendered && (
        <SwipeableDrawer
          title={t('boardSelector.title')}
          placement="bottom"
          open={showBoardSelector}
          onClose={() => setShowBoardSelector(false)}
          onTransitionEnd={handleBoardSelectorTransitionEnd}
        >
          <BoardDiscoveryScroll
            onBoardClick={handleChangeBoardClick}
            onConfigClick={handleChangeConfigClick}
            onCustomClick={() => {
              setShowBoardSelector(false);
              setCustomBoardRendered(true);
              setShowCustomBoard(true);
            }}
          />
        </SwipeableDrawer>
      )}

      {boardConfigs && customBoardRendered && (
        <BoardSelectorDrawer
          open={showCustomBoard}
          onClose={() => setShowCustomBoard(false)}
          onTransitionEnd={handleCustomBoardTransitionEnd}
          boardConfigs={boardConfigs}
          placement="bottom"
          onBoardSelected={(url) => {
            router.push(url);
            setShowCustomBoard(false);
          }}
        />
      )}

      {myBoardsRendered && (
        <MyBoardsDrawer
          open={showMyBoards}
          onClose={() => setShowMyBoards(false)}
          onTransitionEnd={handleMyBoardsTransitionEnd}
          onCreateBoard={() => {
            setShowMyBoards(false);
            setCustomBoardRendered(true);
            setShowCustomBoard(true);
          }}
        />
      )}

      {myGymsRendered && (
        <MyGymsDrawer
          open={showMyGyms}
          onClose={() => setShowMyGyms(false)}
          onTransitionEnd={handleMyGymsTransitionEnd}
        />
      )}

      {devUrlAvailable && <DevUrlDialog open={showDevUrl} onClose={() => setShowDevUrl(false)} />}

      <FeedbackDialog
        open={showRating}
        onClose={() => setShowRating(false)}
        source="drawer-feedback"
        onSubmitted={({ rating }) => {
          // Defensive: the dialog body always calls onClose in its submit
          // path, but closing explicitly here too guarantees no stacking if
          // that ever changes. Idempotent — React coalesces the setState.
          setShowRating(false);
          // Only chain into the App Store prompt on a clearly positive rating —
          // asking a user who just gave us 2 stars to publicly review us is
          // how you end up with 2-star public reviews. The in-app prompt banner
          // already applies the same gating (≥3) for native in-app review.
          if (rating !== null && rating >= 4) {
            setShowStoreReviewPrompt(true);
          }
        }}
      />
      <BugReportDialog open={showBugReport} onClose={() => setShowBugReport(false)} source="drawer-bug" />
      <StoreReviewPromptDialog open={showStoreReviewPrompt} onClose={() => setShowStoreReviewPrompt(false)} />
    </>
  );
}
