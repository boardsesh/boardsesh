import React from 'react';
import { describe, it, expect, vi } from 'vite-plus/test';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { GymFormFieldValues } from '../gym-form';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en-US' },
  }),
}));

// Stub the map picker so the form test doesn't pull in Leaflet.
vi.mock('@/app/components/board-entity/map-location-picker', () => ({
  default: () => <div data-testid="map-picker" />,
}));

import GymForm from '../gym-form';

const initialValues: GymFormFieldValues = {
  name: '',
  description: '',
  address: '',
  website: '',
  contactEmail: '',
  contactPhone: '',
  isPublic: true,
  latitude: null,
  longitude: null,
};

describe('GymForm — create-anyway path', () => {
  it('blocks repeated submit events while a save is pending', async () => {
    let finishSave: (() => void) | undefined;
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { container } = render(
      <GymForm
        title="Create Gym"
        submitLabel="Create Gym"
        initialValues={{ ...initialValues, name: 'Bowlo' }}
        onSubmit={onSubmit}
      />,
    );
    const form = container.querySelector('form');
    if (!form) throw new Error('form missing');
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finishSave?.();
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Create Gym' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('submits unlisted gyms as link-readable without listing them', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <GymForm
        title="Edit gym"
        submitLabel="Save"
        initialValues={{ ...initialValues, name: 'QA', isListed: true }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'gymForm.fields.visibility' }));
    fireEvent.click(await screen.findByRole('option', { name: 'gymForm.visibility.unlisted' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ isPublic: true, isListed: false })),
    );
  });

  it('preserves an omitted legacy listing value when another field changes', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <GymForm
        title="Edit gym"
        submitLabel="Save"
        initialValues={{ ...initialValues, name: 'QA' }}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'gymForm.fields.name' }), { target: { value: 'QA renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: 'QA renamed', isListed: undefined })),
    );
  });

  it('submits unchanged while dedup suggestions are shown, and never disables submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <GymForm
        title="Create Gym"
        submitLabel="Create Gym"
        initialValues={initialValues}
        onSubmit={onSubmit}
        renderSuggestions={({ name }) => <div>{`suggestions for ${name}`}</div>}
      />,
    );

    // Name drives both the suggestions slot and the submit button's enabled state.
    const nameInput = screen.getByRole('textbox', { name: 'gymForm.fields.name' });
    fireEvent.change(nameInput, { target: { value: 'Bahnhof Bloc' } });

    // Suggestions are visible...
    expect(screen.getByText('suggestions for Bahnhof Bloc')).toBeTruthy();

    // ...but the submit button is still enabled ("create anyway").
    const submitButton = screen.getByRole('button', { name: 'Create Gym' });
    expect((submitButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submitButton);

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ name: 'Bahnhof Bloc' });
  });
});
