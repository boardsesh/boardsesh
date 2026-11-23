'use client';

import React, { useRef, useState } from 'react';
import { Alert, Button, Checkbox, FormControlLabel, Stack, TextField } from '@mui/material';
import { ClientError } from 'graphql-request';
import { SUBMIT_BOARD_REQUEST } from '@boardsesh/graphql/operations';
import type { BoardRequestRole, SubmitBoardRequestInput } from '@boardsesh/shared-schema';
import { executeGraphQL } from '@/app/lib/graphql/client';
import { trackBoardRequestSubmitted } from '@/app/lib/analytics';

type BoardRequestLabels = {
  board: string;
  role: string;
  climber: string;
  gym: string;
  maker: string;
  note: string;
  consent: string;
  email: string;
  send: string;
  sent: string;
  error: string;
  rateLimited: string;
};

export default function BoardRequestForm({ labels }: { labels: BoardRequestLabels }) {
  const [boardName, setBoardName] = useState('');
  const [role, setRole] = useState<BoardRequestRole | ''>('');
  const [note, setNote] = useState('');
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [status, setStatus] = useState<'idle' | 'pending' | 'sent' | 'error' | 'limited'>('idle');
  const sending = useRef(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current || !boardName.trim() || !role) return;
    sending.current = true;
    setStatus('pending');
    const input: SubmitBoardRequestInput = {
      boardName: boardName.trim(),
      role,
      note: note.trim() || null,
      contactConsent: consent,
      email: consent ? email.trim() : null,
    };
    try {
      const result = await executeGraphQL<{ submitBoardRequest: boolean }>(SUBMIT_BOARD_REQUEST, { input });
      if (!result.submitBoardRequest) throw new Error('Board request unavailable');
    } catch (error) {
      const limited =
        error instanceof ClientError && error.response.errors?.some((item) => item.extensions?.code === 'RATE_LIMITED');
      setStatus(limited ? 'limited' : 'error');
      sending.current = false;
      return;
    }
    setBoardName('');
    setEmail('');
    setNote('');
    setConsent(false);
    setStatus('sent');
    trackBoardRequestSubmitted(role);
  };

  if (status === 'sent')
    return (
      <Alert
        role="status"
        severity="success"
        tabIndex={-1}
        ref={(element) => {
          element?.focus();
        }}
      >
        {labels.sent}
      </Alert>
    );

  return (
    <Stack
      component="form"
      method="post"
      onSubmit={submit}
      spacing={2}
      sx={{ maxWidth: '60ch' }}
      className="ph-no-capture ph-ignore-input rr-block sentry-block"
    >
      <TextField
        label={labels.board}
        value={boardName}
        required
        disabled={status === 'pending'}
        onChange={(event) => setBoardName(event.target.value)}
        slotProps={{ htmlInput: { maxLength: 100, pattern: '.*\\S.*' } }}
      />
      <TextField
        select
        required
        label={labels.role}
        value={role}
        disabled={status === 'pending'}
        slotProps={{ select: { native: true }, inputLabel: { shrink: true } }}
        onChange={(event) => setRole(event.target.value as BoardRequestRole)}
      >
        <option value="" disabled />
        <option value="climber">{labels.climber}</option>
        <option value="gym">{labels.gym}</option>
        <option value="maker">{labels.maker}</option>
      </TextField>
      <TextField
        label={labels.note}
        disabled={status === 'pending'}
        multiline
        minRows={2}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        slotProps={{ htmlInput: { maxLength: 1000 } }}
      />
      <FormControlLabel
        label={labels.consent}
        control={
          <Checkbox
            disabled={status === 'pending'}
            checked={consent}
            onChange={(event) => {
              setConsent(event.target.checked);
              if (!event.target.checked) setEmail('');
            }}
          />
        }
      />
      {consent && (
        <TextField
          label={labels.email}
          disabled={status === 'pending'}
          value={email}
          required
          type="email"
          autoComplete="email"
          onChange={(event) => setEmail(event.target.value)}
          slotProps={{ htmlInput: { maxLength: 254 } }}
        />
      )}
      {(status === 'error' || status === 'limited') && (
        <Alert severity="error">{status === 'limited' ? labels.rateLimited : labels.error}</Alert>
      )}
      <Button
        type="submit"
        disabled={status === 'pending'}
        variant="contained"
        sx={{ alignSelf: 'flex-start', minHeight: 44 }}
      >
        {labels.send}
      </Button>
    </Stack>
  );
}
