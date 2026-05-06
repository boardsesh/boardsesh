'use client';

import React, { useState, useEffect, type PropsWithChildren } from 'react';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import Badge from '@mui/material/Badge';
import MuiButton from '@mui/material/Button';
import Box from '@mui/material/Box';
import { DeleteOutlined } from '@mui/icons-material';
import { track } from '@/app/lib/analytics';
import { useTranslation } from 'react-i18next';
import type { BoardDetails } from '@/app/lib/types';
import dynamic from 'next/dynamic';

import { getImageUrl } from '@/app/components/board-renderer/util';
import { useQueueActions, useQueueList } from '@/app/components/graphql-queue';
import { ConfirmPopover } from '@/app/components/ui/confirm-popover';
import { TabPanel } from '@/app/components/ui/tab-panel';
import styles from './layout-client.module.css';

const AccordionSearchForm = dynamic(() => import('@/app/components/search-drawer/accordion-search-form'), {
  ssr: false,
});
const SearchResultsFooter = dynamic(() => import('@/app/components/search-drawer/search-results-footer'), {
  ssr: false,
});
const QueueList = dynamic(() => import('@/app/components/queue-control/queue-list'), {
  ssr: false,
});
const TourQueueWatcher = dynamic(() => import('@/app/components/onboarding/tour-queue-watcher'), {
  ssr: false,
});

type ListLayoutClientProps = {
  boardDetails: BoardDetails;
};

// Isolated component for the queue tab label - subscribes to context independently
const QueueTabLabel: React.FC = () => {
  const { t } = useTranslation('session');
  const { queue } = useQueueList();
  return (
    <Badge
      badgeContent={queue.length}
      max={99}
      invisible={queue.length === 0}
      color="primary"
      sx={{ '& .MuiBadge-badge': { right: -8, top: -2 } }}
    >
      {t('queueDrawer.title')}
    </Badge>
  );
};

// Isolated component for the queue tab content - subscribes to context independently
const QueueTabContent: React.FC<{ boardDetails: BoardDetails }> = ({ boardDetails }) => {
  const { t } = useTranslation('session');
  const { queue } = useQueueList();
  const { setQueue } = useQueueActions();
  const [scrollContainerEl, setScrollContainerEl] = useState<HTMLDivElement | null>(null);

  const handleClearQueue = () => {
    setQueue([]);
    track('Queue Cleared', {
      boardLayout: boardDetails.layout_name || '',
      itemsCleared: queue.length,
    });
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {queue.length > 0 && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 8px 0 8px' }}>
          <ConfirmPopover
            title={t('queueDrawer.clearTitle')}
            description={t('queueDrawer.clearDescription')}
            onConfirm={handleClearQueue}
            okText={t('queueDrawer.clearConfirm')}
            cancelText={t('common:actions.cancel')}
          >
            <MuiButton variant="text" startIcon={<DeleteOutlined />} size="small" sx={{ color: 'var(--neutral-400)' }}>
              {t('queueDrawer.clear')}
            </MuiButton>
          </ConfirmPopover>
        </Box>
      )}
      <div ref={setScrollContainerEl} style={{ flex: 1, overflow: 'auto' }}>
        <QueueList boardDetails={boardDetails} scrollContainer={scrollContainerEl} />
      </div>
    </div>
  );
};

const TabsWrapper: React.FC<{ boardDetails: BoardDetails }> = ({ boardDetails }) => {
  const { t } = useTranslation('climbs');
  const [activeTab, setActiveTab] = useState('queue');

  return (
    <>
      <Tabs value={activeTab} onChange={(_, v) => setActiveTab(v)} className={styles.siderTabs}>
        <Tab label={<QueueTabLabel />} value="queue" />
        <Tab label={t('search.actions.search')} value="search" />
      </Tabs>
      <TabPanel value={activeTab} index="queue">
        <QueueTabContent boardDetails={boardDetails} />
      </TabPanel>
      <TabPanel value={activeTab} index="search">
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto' }}>
            <AccordionSearchForm boardDetails={boardDetails} />
          </div>
          <SearchResultsFooter />
        </div>
      </TabPanel>
    </>
  );
};

// Preload thumbnail background images so they stay in the browser's memory
// cache while the virtualizer mounts/unmounts list items on scroll.
const hiddenStyle: React.CSSProperties = { position: 'absolute', width: 0, height: 0 };
const ThumbnailPreload: React.FC<{ boardDetails: BoardDetails }> = React.memo(({ boardDetails }) => (
  <>
    {Object.keys(boardDetails.images_to_holds).map((img) => (
      // eslint-disable-next-line @next/next/no-img-element
      <img key={img} src={getImageUrl(img, boardDetails.board_name, true)} alt="" aria-hidden style={hiddenStyle} />
    ))}
  </>
));
ThumbnailPreload.displayName = 'ThumbnailPreload';

const ListLayoutClient: React.FC<PropsWithChildren<ListLayoutClientProps>> = ({ boardDetails, children }) => {
  // Prefetch full-size board images when the browser is idle so climb detail view loads instantly
  useEffect(() => {
    const links: HTMLLinkElement[] = [];

    const addPrefetchLink = (href: string) => {
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      link.as = 'image';
      document.head.appendChild(link);
      links.push(link);
    };

    const prefetchImages = () => {
      // Prefetch Kilter/Tension board images
      Object.keys(boardDetails.images_to_holds).forEach((imageUrl) => {
        addPrefetchLink(getImageUrl(imageUrl, boardDetails.board_name));
      });

      // Prefetch MoonBoard images (background + hold sets)
      if (boardDetails.layoutFolder) {
        addPrefetchLink('/images/moonboard/moonboard-bg.webp');
        boardDetails.holdSetImages?.forEach((imageFile) => {
          addPrefetchLink(`/images/moonboard/${boardDetails.layoutFolder}/${imageFile.replace(/\.png$/, '.webp')}`);
        });
      }
    };

    // Defer to idle time; fall back to setTimeout for Safari which lacks requestIdleCallback
    const handle =
      typeof requestIdleCallback !== 'undefined'
        ? requestIdleCallback(prefetchImages)
        : (setTimeout(prefetchImages, 1) as unknown as number);

    return () => {
      if (typeof cancelIdleCallback !== 'undefined') {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle);
      }
      links.forEach((link) => link.remove());
    };
  }, [boardDetails]);

  return (
    <Box className={styles.listLayout}>
      <ThumbnailPreload boardDetails={boardDetails} />
      <Box component="main" className={styles.mainContent}>
        {children}
      </Box>
      <Box component="aside" className={styles.sider} sx={{ width: 400, padding: '0 8px 20px 8px' }}>
        <TabsWrapper boardDetails={boardDetails} />
      </Box>
      <TourQueueWatcher />
    </Box>
  );
};

export default ListLayoutClient;
