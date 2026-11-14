'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import { z } from 'zod';

const contextSchema = z
  .object({
    outcome: z.literal('available'),
    actorContextKey: z.string().regex(/^[a-f0-9]{64}$/),
    userId: z.string().min(1),
    authSessionId: z.string().min(1),
  })
  .strict();
const sentSchema = z
  .object({
    outcome: z.literal('email_sent'),
    operationKey: z.string().regex(/^[a-f0-9]{64}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
type FirstPasswordEmailSectionProps = {
  readonly expectedSession: { readonly userId: string; readonly authSessionId: string };
  readonly onAccountChanged?: () => void | Promise<void>;
};
export default function FirstPasswordEmailSection(props: FirstPasswordEmailSectionProps) {
  return (
    <OwnedFirstPasswordEmailSection
      key={JSON.stringify([props.expectedSession.userId, props.expectedSession.authSessionId])}
      {...props}
    />
  );
}
function OwnedFirstPasswordEmailSection({ expectedSession, onAccountChanged }: FirstPasswordEmailSectionProps) {
  const { t } = useTranslation('settings');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error' | 'changed'>('idle');
  const pending = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => pending.current?.abort(), []);
  const send = async () => {
    if (pending.current) return;
    const attempt = new AbortController();
    pending.current = attempt;
    setState('sending');
    try {
      const current = await fetch('/api/internal/auth/first-password/context', {
        cache: 'no-store',
        signal: attempt.signal,
      });
      const context = contextSchema.safeParse(await current.json());
      if (attempt.signal.aborted) return;
      if (!current.ok || !context.success) throw new Error('First-password context unavailable');
      if (
        context.data.userId !== expectedSession.userId ||
        context.data.authSessionId !== expectedSession.authSessionId
      ) {
        setState('changed');
        await onAccountChanged?.();
        return;
      }
      const result = await fetch('/api/internal/auth/first-password/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        signal: attempt.signal,
        body: JSON.stringify({
          actorContextKey: context.data.actorContextKey,
          expectedUserId: expectedSession.userId,
          expectedAuthSessionId: expectedSession.authSessionId,
        }),
      });
      const reply: unknown = await result.json();
      if (attempt.signal.aborted) return;
      if (result.status === 401 || result.status === 409) {
        setState('changed');
        await onAccountChanged?.();
        return;
      }
      if (!result.ok || !sentSchema.safeParse(reply).success) throw new Error('First-password mail unavailable');
      setState('sent');
    } catch {
      if (!attempt.signal.aborted) setState('error');
    } finally {
      if (pending.current === attempt) pending.current = null;
    }
  };
  return (
    <Card>
      <CardContent>
        <Typography variant="h5">{t('firstPassword.title')}</Typography>
        <Typography variant="body2" sx={{ my: 2 }}>
          {t('firstPassword.description')}
        </Typography>
        {state === 'sent' && <Alert severity="success">{t('firstPassword.sent')}</Alert>}
        {state === 'error' && <Alert severity="error">{t('firstPassword.unavailable')}</Alert>}
        {state === 'changed' && <Alert severity="info">{t('password.accountChanged')}</Alert>}
        <Button
          variant="contained"
          onClick={send}
          disabled={
            state === 'sending' ||
            state === 'sent' ||
            state === 'changed' ||
            !expectedSession.userId ||
            !expectedSession.authSessionId
          }
        >
          {state === 'sending' ? t('firstPassword.sending') : t('firstPassword.send')}
        </Button>
      </CardContent>
    </Card>
  );
}
