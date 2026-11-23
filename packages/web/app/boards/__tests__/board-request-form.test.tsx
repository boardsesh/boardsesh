import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { GraphQLError } from 'graphql';
import { ClientError } from 'graphql-request';
import enWebsite from '@boardsesh/i18n/locales/en-US/website.json';
import BoardRequestForm from '../board-request-form';

const { submit, track } = vi.hoisted(() => ({ submit: vi.fn(), track: vi.fn() }));
vi.mock('@/app/lib/graphql/client', () => ({ executeGraphQL: submit }));
vi.mock('@/app/lib/analytics', () => ({ trackBoardRequestSubmitted: track }));
const labels = enWebsite.boardRequest;
beforeEach(() => {
  submit.mockReset();
  track.mockReset();
});
afterEach(cleanup);

function openForm() {
  render(<BoardRequestForm labels={labels} />);
  fireEvent.change(screen.getByRole('combobox', { name: labels.role }), { target: { value: 'climber' } });
  fireEvent.change(screen.getByRole('textbox', { name: labels.board }), { target: { value: ' Fixture board ' } });
  fireEvent.change(screen.getByRole('textbox', { name: labels.note }), { target: { value: 'Private fixture note' } });
}

describe('private board request form', () => {
  it('submits an anonymous request and measures only the fixed role after the server acknowledges it', async () => {
    let finish!: (result: { submitBoardRequest: boolean }) => void;
    submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    openForm();
    expect(screen.queryByRole('textbox', { name: labels.email })).toBeNull();
    const button = screen.getByRole('button', { name: labels.send });
    expect(button.closest('form')?.classList.contains('rr-block')).toBe(true);
    fireEvent.click(button);
    expect(submit).toHaveBeenCalledWith(expect.any(String), {
      input: {
        boardName: 'Fixture board',
        role: 'climber',
        note: 'Private fixture note',
        email: null,
        contactConsent: false,
      },
    });
    expect(track).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    finish({ submitBoardRequest: true });
    expect((await screen.findByRole('status')).textContent).toBe(labels.sent);
    expect(track.mock.calls).toEqual([['climber']]);
  });

  it('clears the optional address when follow-up permission is withdrawn', async () => {
    submit.mockResolvedValue({ submitBoardRequest: true });
    openForm();
    const consent = screen.getByRole('checkbox', { name: labels.consent });
    fireEvent.click(consent);
    fireEvent.change(screen.getByRole('textbox', { name: labels.email }), {
      target: { value: 'fixture@example.test' },
    });
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole('button', { name: labels.send }));
    await screen.findByRole('status');
    expect(submit.mock.calls[0][1].input).toMatchObject({ email: null, contactConsent: false });
  });

  it('keeps entered text after a rate limit or write error and permits a deliberate retry', async () => {
    submit
      .mockRejectedValueOnce(
        new ClientError(
          {
            status: 200,
            headers: new Headers(),
            body: '',
            errors: [new GraphQLError('Wait', { extensions: { code: 'RATE_LIMITED' } })],
          },
          { query: 'fixture' },
        ),
      )
      .mockResolvedValueOnce({ submitBoardRequest: false })
      .mockResolvedValueOnce({ submitBoardRequest: true });
    openForm();
    const button = screen.getByRole('button', { name: labels.send });
    fireEvent.click(button);
    expect(await screen.findByText(labels.rateLimited)).toBeTruthy();
    fireEvent.click(button);
    expect(await screen.findByText(labels.error)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: labels.board }) as HTMLInputElement).value).toBe(' Fixture board ');
    expect(track).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(track).toHaveBeenCalledTimes(1));
  });
});
