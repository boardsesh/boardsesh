'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { useSession } from 'next-auth/react';
import { useTranslation } from 'react-i18next';
import type {
  PartnerWebhookCredentials,
  PartnerWebhookDelivery,
  PartnerWebhookSettings,
} from '@boardsesh/shared-schema';
import {
  GET_PARTNER_WEBHOOK_DELIVERIES,
  GET_PARTNER_WEBHOOK_SETTINGS,
  ROTATE_PARTNER_WEBHOOK_SECRET,
  TEST_PARTNER_WEBHOOK,
  UPDATE_PARTNER_WEBHOOK,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { classifyConsoleError } from '@/app/lib/developer-apps/console-errors';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';
import CopyValue from './copy-value';
import SignInAgainDialog from './sign-in-again-dialog';

const EVENTS = ['logbook.changed', 'workout.completed', 'connection.revoked'] as const;
type WebhookAction = 'save' | 'toggle' | 'rotate' | 'test';
type LoadedWebhook = {
  identity: string;
  settings: PartnerWebhookSettings | null;
  deliveries: PartnerWebhookDelivery[];
};

/** Secrets live only in this mounted dialog, never a query cache or browser store. */
export default function WebhookDialog({
  clientId,
  appName,
  onClose,
}: {
  clientId: string;
  appName: string;
  onClose: () => void;
}) {
  const { t } = useTranslation('developers');
  const { data: session } = useSession();
  const { token } = useWsAuthToken();
  const identity = `${session?.user?.id ?? ''}:${token ?? ''}:${clientId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const generation = useRef(0);
  const titleId = useId();
  const [loaded, setLoaded] = useState<LoadedWebhook | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([...EVENTS]);
  const [enabled, setEnabled] = useState(true);
  const [secret, setSecret] = useState<{ identity: string; text: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<'saved' | 'test' | null>(null);
  const [signInAgain, setSignInAgain] = useState(false);
  const visibleSecret = secret?.identity === identity ? secret.text : null;
  const current = loaded?.identity === identity ? loaded : null;
  const overlapExpiresAt = current?.settings?.previousSecretExpiresAt;
  const rotationBlocked = Boolean(overlapExpiresAt && new Date(overlapExpiresAt).getTime() > Date.now());
  let validUrl = false;
  try {
    const candidate = new URL(url);
    validUrl =
      candidate.protocol === 'https:' &&
      (!candidate.port || candidate.port === '443') &&
      !candidate.username &&
      !candidate.password &&
      !candidate.hash;
  } catch {
    /* The backend additionally checks DNS and address ranges. */
  }

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current;
    setLoading(true);
    setProblem(null);
    setSecret(null);
    setWorking(false);
    setNotice(null);
    setSignInAgain(false);
    if (!token || !session?.user?.id) {
      setLoading(false);
      setLoaded(null);
      return;
    }
    try {
      const client = createGraphQLHttpClient(token);
      const [settings, deliveries] = await Promise.all([
        client.request<{ partnerWebhookSettings: PartnerWebhookSettings | null }>(GET_PARTNER_WEBHOOK_SETTINGS, {
          clientId,
        }),
        client.request<{ partnerWebhookDeliveries: PartnerWebhookDelivery[] }>(GET_PARTNER_WEBHOOK_DELIVERIES, {
          clientId,
        }),
      ]);
      if (generation.current !== requestGeneration || currentIdentity.current !== identity) return;
      const configured = settings.partnerWebhookSettings;
      setLoaded({ identity, settings: configured, deliveries: deliveries.partnerWebhookDeliveries });
      setUrl(configured?.url ?? '');
      setEvents(configured?.events ?? [...EVENTS]);
      setEnabled(configured?.enabled ?? true);
    } catch {
      if (generation.current === requestGeneration && currentIdentity.current === identity)
        setProblem(t('webhooks.failed'));
    } finally {
      if (generation.current === requestGeneration && currentIdentity.current === identity) setLoading(false);
    }
  }, [clientId, identity, session?.user?.id, t, token]);

  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  const run = async (action: WebhookAction) => {
    if (!token || !current || working || visibleSecret) return;
    const operationGeneration = ++generation.current;
    setWorking(true);
    setProblem(null);
    setNotice(null);
    try {
      const client = createGraphQLHttpClient(token);
      let credentials: PartnerWebhookCredentials | undefined;
      if (action === 'test') {
        await client.request(TEST_PARTNER_WEBHOOK, { clientId });
      } else if (action === 'rotate') {
        const response = await client.request<{ rotatePartnerWebhookSecret: PartnerWebhookCredentials }>(
          ROTATE_PARTNER_WEBHOOK_SECRET,
          { clientId },
        );
        credentials = response.rotatePartnerWebhookSecret;
      } else {
        const toggling = action === 'toggle' && current.settings;
        const response = await client.request<{ updatePartnerWebhook: PartnerWebhookCredentials }>(
          UPDATE_PARTNER_WEBHOOK,
          {
            input: {
              clientId,
              url: toggling ? toggling.url : url,
              events: toggling ? toggling.events : events,
              enabled: action === 'toggle' ? !current.settings?.enabled : enabled,
            },
          },
        );
        credentials = response.updatePartnerWebhook;
      }
      if (generation.current !== operationGeneration || currentIdentity.current !== identity) return;
      if (credentials) {
        setLoaded({ ...current, settings: credentials.settings });
        setUrl(credentials.settings.url);
        setEvents(credentials.settings.events);
        setEnabled(credentials.settings.enabled);
        if (credentials.secret) setSecret({ identity, text: credentials.secret });
      }
      setNotice(action === 'test' ? 'test' : 'saved');
    } catch (error) {
      if (generation.current !== operationGeneration || currentIdentity.current !== identity) return;
      const classified = classifyConsoleError(error);
      if (classified.kind === 'sign-in-again') setSignInAgain(true);
      else setProblem(classified.kind === 'invalid-input' ? classified.message : t('webhooks.failed'));
    } finally {
      if (generation.current === operationGeneration && currentIdentity.current === identity) setWorking(false);
    }
  };

  const deliveryStatus = (status: string): string => {
    switch (status) {
      case 'delivered':
        return t('webhooks.deliveryStatus.delivered');
      case 'failed':
        return t('webhooks.deliveryStatus.failed');
      case 'cancelled':
        return t('webhooks.deliveryStatus.cancelled');
      case 'retrying':
        return t('webhooks.deliveryStatus.retrying');
      default:
        return t('webhooks.deliveryStatus.pending');
    }
  };
  const locked = working || Boolean(visibleSecret);

  return (
    <>
      <Dialog
        open
        onClose={visibleSecret || working ? undefined : onClose}
        disableEscapeKeyDown={Boolean(visibleSecret) || working}
        aria-labelledby={titleId}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle id={titleId}>{t('webhooks.title', { app: appName })}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            <Typography>{t('webhooks.description')}</Typography>
            {loading || (!current && !problem) ? <CircularProgress aria-label={t('webhooks.loading')} /> : null}
            {problem ? <Alert severity="error">{problem}</Alert> : null}
            {!current && problem ? <Button onClick={() => void load()}>{t('webhooks.retry')}</Button> : null}
            {current ? (
              <>
                {current.settings?.disabledReason ? (
                  <Alert severity="warning">
                    {current.settings.disabledReason === 'endpoint_gone'
                      ? t('webhooks.endpointGone')
                      : t('webhooks.failuresDisabled')}
                  </Alert>
                ) : null}
                <TextField
                  label={t('webhooks.url')}
                  helperText={t('webhooks.urlHelp')}
                  value={url}
                  type="url"
                  fullWidth
                  disabled={locked}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setNotice(null);
                  }}
                />
                <FormGroup aria-label={t('webhooks.events')}>
                  {EVENTS.map((event) => (
                    <FormControlLabel
                      key={event}
                      label={event}
                      control={
                        <Checkbox
                          checked={events.includes(event)}
                          disabled={locked}
                          onChange={(_change, checked) =>
                            setEvents((previous) =>
                              checked ? [...previous, event] : previous.filter((selected) => selected !== event),
                            )
                          }
                        />
                      }
                    />
                  ))}
                </FormGroup>
                <FormControlLabel
                  label={t('webhooks.enabled')}
                  control={
                    <Switch checked={enabled} disabled={locked} onChange={(_event, checked) => setEnabled(checked)} />
                  }
                />
                <Button
                  variant="contained"
                  disabled={locked || !validUrl || events.length === 0}
                  onClick={() => void run('save')}
                >
                  {working ? t('webhooks.saving') : t('webhooks.save')}
                </Button>
                {notice ? (
                  <Alert severity="success">{notice === 'test' ? t('webhooks.testQueued') : t('webhooks.saved')}</Alert>
                ) : null}
                {visibleSecret ? (
                  <>
                    <Alert severity="warning">{t('webhooks.secretOnce')}</Alert>
                    <CopyValue
                      value={visibleSecret}
                      label={t('webhooks.secret')}
                      onCopyFailed={() => setProblem(t('secret.copyFailed'))}
                    />
                    <Button onClick={() => setSecret(null)}>{t('secret.confirmSaved')}</Button>
                  </>
                ) : null}
                {current.settings ? (
                  <>
                    <Typography variant="body2">{t('webhooks.rotationHelp')}</Typography>
                    {rotationBlocked && overlapExpiresAt ? (
                      <Typography variant="body2">
                        {t('webhooks.rotationAvailableAfter', { time: new Date(overlapExpiresAt).toLocaleString() })}
                      </Typography>
                    ) : null}
                    <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
                      <Button disabled={locked || rotationBlocked} onClick={() => void run('rotate')}>
                        {t('webhooks.rotate')}
                      </Button>
                      <Button disabled={locked || !current.settings.enabled} onClick={() => void run('test')}>
                        {t('webhooks.test')}
                      </Button>
                      <Button
                        disabled={locked || (!current.settings.enabled && (!validUrl || events.length === 0))}
                        onClick={() => void run('toggle')}
                      >
                        {current.settings.enabled ? t('webhooks.disable') : t('webhooks.enable')}
                      </Button>
                    </Stack>
                  </>
                ) : null}
                <Typography variant="h3">{t('webhooks.deliveries')}</Typography>
                <Button disabled={locked} onClick={() => void load()}>
                  {t('webhooks.refresh')}
                </Button>
                {current.deliveries.length === 0 ? (
                  <Typography>{t('webhooks.noDeliveries')}</Typography>
                ) : (
                  <Stack component="ul" spacing={1} sx={{ pl: 2 }}>
                    {current.deliveries.map((delivery) => (
                      <Typography component="li" key={delivery.id} variant="body2">
                        {t('webhooks.delivery', {
                          event: delivery.event,
                          status: deliveryStatus(delivery.status),
                          attempts: delivery.attempts,
                          code: delivery.lastStatusCode ?? t('webhooks.noResponse'),
                        })}
                      </Typography>
                    ))}
                  </Stack>
                )}
              </>
            ) : null}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={locked} onClick={onClose}>
            {t('webhooks.close')}
          </Button>
        </DialogActions>
      </Dialog>
      {signInAgain ? <SignInAgainDialog fromForm fromWebhook onClose={() => setSignInAgain(false)} /> : null}
    </>
  );
}
