'use client';

import { useState, useRef, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ToggleButton from '@mui/material/ToggleButton';
import NotificationsNoneOutlined from '@mui/icons-material/NotificationsNoneOutlined';
import NotificationsActiveOutlined from '@mui/icons-material/NotificationsActiveOutlined';
import CircularProgress from '@mui/material/CircularProgress';
import { useSnackbar } from '@/app/components/providers/snackbar-provider';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLClient, execute, type Client } from '@/app/lib/realtime/graphql-client';
import { getBackendWsUrl } from '@/app/lib/backend-url';
import {
  SUBSCRIBE_NEW_CLIMBS,
  UNSUBSCRIBE_NEW_CLIMBS,
  type SubscribeNewClimbsVariables,
  type SubscribeNewClimbsResponse,
  type UnsubscribeNewClimbsVariables,
  type UnsubscribeNewClimbsResponse,
} from '@boardsesh/graphql/operations/new-climb-feed';

type SubscribeButtonProps = {
  boardType: string;
  layoutId: number;
  isSubscribed: boolean;
  onSubscriptionChange?: (isSubscribed: boolean) => void;
  disabled?: boolean;
};

export default function SubscribeButton({
  boardType,
  layoutId,
  isSubscribed,
  onSubscriptionChange,
  disabled,
}: SubscribeButtonProps) {
  const { t } = useTranslation('feed');
  const { token: wsAuthToken } = useWsAuthToken();
  const { showMessage } = useSnackbar();
  const clientRef = useRef<Client | null>(null);
  const [loading, setLoading] = useState(false);

  const ensureClient = useCallback(() => {
    if (!clientRef.current) {
      clientRef.current = createGraphQLClient({
        url: getBackendWsUrl()!,
        authToken: wsAuthToken,
      });
    }
    return clientRef.current;
  }, [wsAuthToken]);

  const handleToggle = async () => {
    if (loading || disabled) return;
    if (!wsAuthToken) {
      showMessage(t('subscribeButton.signInPrompt'), 'warning');
      return;
    }

    setLoading(true);
    try {
      const client = ensureClient();

      if (isSubscribed) {
        const variables: UnsubscribeNewClimbsVariables = {
          input: { boardType, layoutId },
        };
        await execute<UnsubscribeNewClimbsResponse, UnsubscribeNewClimbsVariables>(client, {
          query: UNSUBSCRIBE_NEW_CLIMBS,
          variables,
        });
        onSubscriptionChange?.(false);
        showMessage(t('subscribeButton.unsubscribed'), 'success');
      } else {
        const variables: SubscribeNewClimbsVariables = {
          input: { boardType, layoutId },
        };
        await execute<SubscribeNewClimbsResponse, SubscribeNewClimbsVariables>(client, {
          query: SUBSCRIBE_NEW_CLIMBS,
          variables,
        });
        onSubscriptionChange?.(true);
        showMessage(t('subscribeButton.subscribed'), 'success');
      }
    } catch (err) {
      console.error('Subscription toggle failed', err);
      showMessage(t('subscribeButton.updateFailed'), 'error');
    } finally {
      setLoading(false);
    }
  };

  let buttonIcon: ReactNode;
  if (loading) {
    buttonIcon = <CircularProgress size={16} />;
  } else if (isSubscribed) {
    buttonIcon = <NotificationsActiveOutlined fontSize="small" />;
  } else {
    buttonIcon = <NotificationsNoneOutlined fontSize="small" />;
  }

  return (
    <ToggleButton
      value="subscribe"
      size="small"
      selected={isSubscribed}
      onChange={handleToggle}
      disabled={disabled || loading}
      sx={{ gap: 0.5, textTransform: 'none' }}
    >
      {buttonIcon}
      {isSubscribed ? 'Subscribed' : 'Subscribe'}
    </ToggleButton>
  );
}
