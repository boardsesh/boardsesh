'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { AdminPartnerApp } from '@boardsesh/shared-schema';
import {
  ADMIN_PARTNER_APPS,
  UPDATE_PARTNER_APP_LIMITS,
  type AdminPartnerAppsQueryResponse,
  type AdminPartnerAppsQueryVariables,
  type UpdatePartnerAppLimitsMutationResponse,
  type UpdatePartnerAppLimitsMutationVariables,
} from '@boardsesh/graphql/operations';
import { useWsAuthToken } from '@/app/hooks/use-ws-auth-token';
import { createGraphQLHttpClient } from '@/app/lib/graphql/client';

const PAGE_SIZE = 50;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function parseCap(input: string): number | null {
  if (!/^\d+$/.test(input)) return null;
  const cap = Number(input);
  return Number.isInteger(cap) && cap >= 0 && cap <= POSTGRES_INTEGER_MAX ? cap : null;
}

function PartnerAppRow({
  app,
  token,
  onSaved,
}: {
  app: AdminPartnerApp;
  token: string;
  onSaved: (app: AdminPartnerApp) => void;
}) {
  const { t } = useTranslation('admin');
  const [activeCap, setActiveCap] = useState(String(app.maxActiveConnections));
  const [dailyCap, setDailyCap] = useState(String(app.maxNewConnectionsPerDay));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const parsedActive = parseCap(activeCap);
  const parsedDaily = parseCap(dailyCap);
  const invalid = parsedActive === null || parsedDaily === null;
  const changed = parsedActive !== app.maxActiveConnections || parsedDaily !== app.maxNewConnectionsPerDay;

  useEffect(() => {
    setActiveCap(String(app.maxActiveConnections));
    setDailyCap(String(app.maxNewConnectionsPerDay));
  }, [app.maxActiveConnections, app.maxNewConnectionsPerDay]);

  const save = async () => {
    if (invalid || saving) return;
    setSaving(true);
    setError(false);
    setSaved(false);
    try {
      const result = await createGraphQLHttpClient(token).request<
        UpdatePartnerAppLimitsMutationResponse,
        UpdatePartnerAppLimitsMutationVariables
      >(UPDATE_PARTNER_APP_LIMITS, {
        input: { clientId: app.clientId, maxActiveConnections: parsedActive, maxNewConnectionsPerDay: parsedDaily },
      });
      onSaved(result.updatePartnerAppLimits);
      setSaved(true);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <TableRow>
      <TableCell>
        <Typography>{app.name || app.clientId}</Typography>
        <Typography variant="caption" component="div">
          {app.clientId}
        </Typography>
        {app.publisherName && <Typography variant="body2">{app.publisherName}</Typography>}
        <Typography variant="body2">
          {t(app.disabled || app.suspendedAt ? 'partnerApps.suspended' : 'partnerApps.active')}
        </Typography>
        {app.suspensionReason && <Typography variant="caption">{app.suspensionReason}</Typography>}
      </TableCell>
      <TableCell>
        <Typography variant="body2">{app.ownerName || app.ownerUserId}</Typography>
        <Typography variant="caption">{app.ownerEmail}</Typography>
      </TableCell>
      <TableCell>
        {t('partnerApps.usage', { active: app.activeConnections, recent: app.newConnectionsLast24Hours })}
      </TableCell>
      <TableCell>
        <Stack spacing={1}>
          <TextField
            label={t('partnerApps.activeLimit')}
            value={activeCap}
            size="small"
            type="number"
            disabled={saving}
            error={parsedActive === null}
            slotProps={{ htmlInput: { min: 0, max: POSTGRES_INTEGER_MAX, step: 1 } }}
            onChange={(event) => {
              setActiveCap(event.target.value);
              setSaved(false);
            }}
          />
          <TextField
            label={t('partnerApps.dailyLimit')}
            value={dailyCap}
            size="small"
            type="number"
            disabled={saving}
            error={parsedDaily === null}
            slotProps={{ htmlInput: { min: 0, max: POSTGRES_INTEGER_MAX, step: 1 } }}
            onChange={(event) => {
              setDailyCap(event.target.value);
              setSaved(false);
            }}
          />
          {invalid && (
            <Typography color="error" variant="caption">
              {t('partnerApps.invalidLimit')}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>
        <Button disabled={invalid || !changed || saving} onClick={() => void save()}>
          {t('partnerApps.save')}
        </Button>
        {error && <Alert severity="error">{t('partnerApps.saveError')}</Alert>}
        {saved && (
          <Typography role="status" variant="body2">
            {t('partnerApps.saved')}
          </Typography>
        )}
      </TableCell>
    </TableRow>
  );
}

export default function PartnerAppsPanel() {
  const { t } = useTranslation('admin');
  const { token } = useWsAuthToken();
  const [apps, setApps] = useState<AdminPartnerApp[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const requestGeneration = useRef(0);
  const currentToken = useRef(token);
  currentToken.current = token;

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(false);
    if (!token) {
      setApps([]);
      setLoading(false);
      return;
    }
    try {
      const result = await createGraphQLHttpClient(token).request<
        AdminPartnerAppsQueryResponse,
        AdminPartnerAppsQueryVariables
      >(ADMIN_PARTNER_APPS, { input: { query: query || undefined, limit: PAGE_SIZE, offset } });
      if (generation !== requestGeneration.current || token !== currentToken.current) return;
      setApps(result.adminPartnerApps.apps);
      setTotalCount(result.adminPartnerApps.totalCount);
      setHasMore(result.adminPartnerApps.hasMore);
    } catch {
      if (generation === requestGeneration.current && token === currentToken.current) setError(true);
    } finally {
      if (generation === requestGeneration.current && token === currentToken.current) setLoading(false);
    }
  }, [token, query, offset]);

  useEffect(() => {
    void load();
    return () => {
      requestGeneration.current += 1;
    };
  }, [load]);

  return (
    <Stack spacing={2}>
      <Alert severity="info">{t('partnerApps.limitsHelp')}</Alert>
      <Box
        component="form"
        onSubmit={(event) => {
          event.preventDefault();
          setOffset(0);
          setQuery(queryInput.trim());
        }}
        sx={{ display: 'flex', gap: 2 }}
      >
        <TextField
          label={t('partnerApps.search')}
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          size="small"
          fullWidth
        />
        <Button type="submit">{t('partnerApps.searchAction')}</Button>
      </Box>
      {loading ? (
        <CircularProgress aria-label={t('partnerApps.loading')} />
      ) : error ? (
        <Alert severity="error" action={<Button onClick={() => void load()}>{t('partnerApps.retry')}</Button>}>
          {t('partnerApps.loadError')}
        </Alert>
      ) : (
        <>
          <Typography>{t('partnerApps.total', { count: totalCount })}</Typography>
          {apps.length === 0 ? (
            <Typography>{t('partnerApps.empty')}</Typography>
          ) : (
            <TableContainer>
              <Table>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('partnerApps.app')}</TableCell>
                    <TableCell>{t('partnerApps.developer')}</TableCell>
                    <TableCell>{t('partnerApps.connections')}</TableCell>
                    <TableCell>{t('partnerApps.limits')}</TableCell>
                    <TableCell>{t('partnerApps.actions')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {token &&
                    apps.map((app) => (
                      <PartnerAppRow
                        key={app.clientId}
                        app={app}
                        token={token}
                        onSaved={(updated) => {
                          if (token === currentToken.current)
                            setApps((previous) =>
                              previous.map((candidate) =>
                                candidate.clientId === updated.clientId ? updated : candidate,
                              ),
                            );
                        }}
                      />
                    ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          <Stack direction="row" spacing={2}>
            <Button disabled={offset === 0} onClick={() => setOffset((previous) => Math.max(0, previous - PAGE_SIZE))}>
              {t('partnerApps.previous')}
            </Button>
            <Button disabled={!hasMore} onClick={() => setOffset((previous) => previous + PAGE_SIZE)}>
              {t('partnerApps.next')}
            </Button>
          </Stack>
        </>
      )}
    </Stack>
  );
}
