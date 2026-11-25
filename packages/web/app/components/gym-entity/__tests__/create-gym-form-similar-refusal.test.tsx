import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SimilarGym } from '@boardsesh/shared-schema';
import type { GymFormFieldValues } from '../gym-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/hooks/use-ws-auth-token', () => ({
  useWsAuthToken: () => ({ token: 'test-token', isAuthenticated: true }),
}));

const mockRequest = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/graphql/client', () => ({
  createGraphQLHttpClient: () => ({ request: mockRequest }),
}));

const showMessage = vi.hoisted(() => vi.fn());
vi.mock('@/app/components/providers/snackbar-provider', () => ({
  useSnackbar: () => ({ showMessage }),
}));

const trackGymFunnelEvent = vi.hoisted(() => vi.fn());
vi.mock('@/app/lib/gym-funnel-analytics', () => ({
  trackGymFunnelEvent,
  viewerStateFrom: () => 'signed-in',
}));

vi.mock('../claim-gym-dialog', () => ({ default: () => null }));
vi.mock('../similar-gym-suggestions', () => ({ default: () => null }));

// The form itself is covered elsewhere; a stub that submits fixed values keeps
// this test on what CreateGymForm does with the server's answer.
const submittedValues: GymFormFieldValues = {
  name: '  Bahnhof Bloc ',
  description: '',
  hours: '',
  address: '',
  website: '',
  contactEmail: '',
  contactPhone: '',
  isPublic: true,
  isListed: true,
  latitude: 47,
  longitude: 8,
};
vi.mock('../gym-form', () => ({
  default: ({
    onSubmit,
    submitLabel,
  }: {
    onSubmit: (values: GymFormFieldValues) => Promise<void>;
    submitLabel: string;
  }) => <button onClick={() => void onSubmit(submittedValues)}>{submitLabel}</button>,
}));

import CreateGymForm from '../create-gym-form';

const similarGym = (uuid: string, name: string): SimilarGym => ({
  uuid,
  slug: uuid,
  name,
  address: null,
  website: null,
  distanceMeters: 40,
  ownerType: 'SYSTEM',
  isClaimable: false,
  canClaimByDomain: false,
  providerOrigins: [],
});

const similarGymsRefusal = (gyms: SimilarGym[]) => ({
  response: {
    errors: [
      {
        message: 'A gym like this may already be listed',
        extensions: { code: 'GYM_SIMILAR_EXISTS', candidates: gyms },
      },
    ],
  },
});

const createdGym = { uuid: 'new-gym', name: 'Bahnhof Bloc' };

/** The `input` of each createGym request, in order. */
const sentInputs = () => mockRequest.mock.calls.map((call) => (call[1] as { input: Record<string, unknown> }).input);

describe('CreateGymForm, similar-gym refusal', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    showMessage.mockReset();
    trackGymFunnelEvent.mockReset();
  });

  it('shows the gyms the server named, and resends as a separate gym when the climber says no', async () => {
    const onSuccess = vi.fn();
    mockRequest
      .mockRejectedValueOnce(similarGymsRefusal([similarGym('gym-1', 'Bahnhof Bloc'), similarGym('gym-2', 'Bloc Bar')]))
      .mockResolvedValueOnce({ createGym: createdGym });

    render(<CreateGymForm submitLabel="Save" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('similarGyms.refusal.title')).toBeTruthy();
    expect(screen.getByText('Bloc Bar')).toBeTruthy();
    // The refusal is the answer, not a failure: no error toast.
    expect(showMessage).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'similarGyms.refusal.addNew' }));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(createdGym));
    const [firstInput, secondInput] = sentInputs();
    expect(firstInput).toMatchObject({ name: 'Bahnhof Bloc', latitude: 47, longitude: 8 });
    expect(firstInput.duplicateCheck).toBeUndefined();
    expect(secondInput).toMatchObject({
      name: 'Bahnhof Bloc',
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['gym-1', 'gym-2'] },
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('acknowledges every gym shown so far when a confirmation is refused with more', async () => {
    mockRequest
      .mockRejectedValueOnce(similarGymsRefusal([similarGym('gym-1', 'Bahnhof Bloc')]))
      .mockRejectedValueOnce(similarGymsRefusal([similarGym('gym-6', 'Far Bloc')]))
      .mockResolvedValueOnce({ createGym: createdGym });

    render(<CreateGymForm submitLabel="Save" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'similarGyms.refusal.addNew' }));

    expect(await screen.findByText('Far Bloc')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'similarGyms.refusal.addNew' }));

    await waitFor(() => expect(sentInputs()).toHaveLength(3));
    expect(sentInputs()[2]).toMatchObject({
      duplicateCheck: { mode: 'CONFIRMED_SEPARATE', acknowledgedGymUuids: ['gym-1', 'gym-6'] },
    });
  });

  it('starts a fresh check after the climber goes back to the form', async () => {
    mockRequest
      .mockRejectedValueOnce(similarGymsRefusal([similarGym('gym-1', 'Bahnhof Bloc')]))
      .mockResolvedValueOnce({ createGym: createdGym });

    render(<CreateGymForm submitLabel="Save" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'similarGyms.refusal.back' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(sentInputs()).toHaveLength(2));
    expect(sentInputs()[1].duplicateCheck).toBeUndefined();
  });

  it('keeps only the 50 most recent gyms it was shown when it confirms', async () => {
    const firstRound = Array.from({ length: 48 }, (_, index) => similarGym(`old-${index}`, `Old ${index}`));
    const secondRound = Array.from({ length: 5 }, (_, index) => similarGym(`new-${index}`, `New ${index}`));
    mockRequest
      .mockRejectedValueOnce(similarGymsRefusal(firstRound))
      .mockRejectedValueOnce(similarGymsRefusal(secondRound))
      .mockResolvedValueOnce({ createGym: createdGym });

    render(<CreateGymForm submitLabel="Save" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'similarGyms.refusal.addNew' }));
    expect(await screen.findByText('New 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'similarGyms.refusal.addNew' }));

    await waitFor(() => expect(sentInputs()).toHaveLength(3));
    const acknowledged = (sentInputs()[2].duplicateCheck as { acknowledgedGymUuids: string[] }).acknowledgedGymUuids;
    expect(acknowledged).toHaveLength(50);
    expect(acknowledged.slice(0, 2)).toEqual(['old-3', 'old-4']);
    expect(acknowledged.slice(-5)).toEqual(secondRound.map((gym) => gym.uuid));
  });

  it("counts a Claim from the refusal dialog under the refusal's own placement", async () => {
    mockRequest.mockRejectedValueOnce(
      similarGymsRefusal([{ ...similarGym('gym-1', 'Bahnhof Bloc'), isClaimable: true }]),
    );

    render(<CreateGymForm submitLabel="Save" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'similarGyms.claim' }));

    expect(trackGymFunnelEvent).toHaveBeenCalledWith(
      expect.objectContaining({ properties: expect.objectContaining({ placement: 'similar-gyms-refusal' }) }),
    );
  });

  it('says the account is at its gym limit instead of the server text', async () => {
    mockRequest.mockRejectedValueOnce({
      response: {
        errors: [{ message: 'English server text', extensions: { code: 'GYM_LIMIT_REACHED', maxGyms: 25 } }],
      },
    });

    render(<CreateGymForm submitLabel="Save" />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(showMessage).toHaveBeenCalledWith('gymForm.create.limitReached', 'error'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
