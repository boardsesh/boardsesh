import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { tFromCatalog } from '@/app/__test-helpers__/i18n-mock';
import type { ClimbQueueItem } from '@/app/components/queue-control/types';
import ObsRecorderPanel, { formatObsClimbOverlayText } from '../obs-recorder-panel';

const obsMocks = vi.hoisted(() => {
  class ClientError extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly requestType?: string,
    ) {
      super(message);
      this.name = 'ObsWebSocketClientError';
    }
  }

  class RequestError extends Error {
    constructor(
      message: string,
      readonly requestType: string,
      readonly code?: number,
    ) {
      super(message);
      this.name = 'ObsWebSocketRequestError';
    }
  }

  const client = {
    isConnected: false,
    connect: vi.fn(async () => {
      client.isConnected = true;
    }),
    disconnect: vi.fn(() => {
      client.isConnected = false;
    }),
    startRecording: vi.fn(async () => ({})),
    stopRecording: vi.fn(async () => ({ outputPath: '/videos/Moon Ladder.mp4' })),
    setInputSettings: vi.fn(async () => ({})),
  };

  return {
    client,
    ClientError,
    RequestError,
    constructor: vi.fn(function MockObsWebSocketClient(_url?: string, _password?: string, _options?: unknown) {
      return client;
    }),
  };
});

const preferenceMocks = vi.hoisted(() => ({
  getPreference: vi.fn(async (_key: string): Promise<unknown> => null),
  setPreference: vi.fn(async (_key: string, _value: unknown): Promise<void> => undefined),
}));

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, options?: Record<string, unknown>) => tFromCatalog(ns, key, options),
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/app/lib/obs-websocket-client', () => ({
  ObsWebSocketClient: obsMocks.constructor,
  ObsWebSocketClientError: obsMocks.ClientError,
  ObsWebSocketRequestError: obsMocks.RequestError,
  getObsErrorMessage: (error: unknown) => (error instanceof Error ? error.message : ''),
}));

vi.mock('@/app/lib/user-preferences-db', () => ({
  getPreference: (key: string) => preferenceMocks.getPreference(key),
  setPreference: (key: string, value: unknown) => preferenceMocks.setPreference(key, value),
}));

const climbQueueItem: ClimbQueueItem = {
  uuid: 'queue-1',
  climb: {
    uuid: 'climb-1',
    setter_username: 'setter',
    name: 'Moon Ladder',
    frames: '',
    angle: 40,
    ascensionist_count: 0,
    difficulty: 'V5',
    quality_average: '0',
    stars: 0,
    difficulty_error: '0',
    benchmark_difficulty: null,
  },
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
};

describe('ObsRecorderPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    obsMocks.client.isConnected = false;
    obsMocks.client.connect.mockImplementation(async () => {
      obsMocks.client.isConnected = true;
    });
    obsMocks.client.disconnect.mockImplementation(() => {
      obsMocks.client.isConnected = false;
    });
    obsMocks.client.startRecording.mockResolvedValue({});
    obsMocks.client.stopRecording.mockResolvedValue({ outputPath: '/videos/Moon Ladder.mp4' });
    obsMocks.client.setInputSettings.mockResolvedValue({});
    preferenceMocks.getPreference.mockResolvedValue(null);
    preferenceMocks.setPreference.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats the climb overlay from the active queue item', () => {
    expect(formatObsClimbOverlayText(climbQueueItem)).toBe('Moon Ladder\nV5 / 40\u00b0');
  });

  it('connects to OBS and records the active climb', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(obsMocks.client.connect).toHaveBeenCalled();
    });
    expect(obsMocks.constructor).toHaveBeenCalledWith(
      'ws://127.0.0.1:4455',
      undefined,
      expect.objectContaining({ onRecordStateChanged: expect.any(Function) }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });
    expect(obsMocks.client.setInputSettings).toHaveBeenCalledWith(
      'Boardsesh Climb Overlay',
      { text: 'Moon Ladder\nV5 / 40\u00b0' },
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(obsMocks.client.stopRecording).toHaveBeenCalled();
    });
    expect(screen.getByText('/videos/Moon Ladder.mp4')).toBeTruthy();
  });

  it('passes a typed OBS password to the websocket client without persisting it', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.change(screen.getByLabelText('OBS password'), { target: { value: 'obs-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(obsMocks.client.connect).toHaveBeenCalled();
    });
    expect(obsMocks.constructor).toHaveBeenCalledWith(
      'ws://127.0.0.1:4455',
      'obs-secret',
      expect.objectContaining({ onRecordStateChanged: expect.any(Function) }),
    );
    expect(preferenceMocks.setPreference).not.toHaveBeenCalled();
    expect(preferenceMocks.setPreference).not.toHaveBeenCalledWith(
      'obsRecorderSettings',
      expect.objectContaining({ password: 'obs-secret' }),
    );
  });

  it('disconnects the websocket when a manual connect attempt fails', async () => {
    obsMocks.client.connect.mockRejectedValueOnce(new Error('No OBS'));
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(screen.getByText('No OBS')).toBeTruthy();
    });
    expect(obsMocks.client.disconnect).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect OBS' })).toBeTruthy();
  });

  it('localizes known OBS client errors by code', async () => {
    obsMocks.client.connect.mockRejectedValueOnce(
      new obsMocks.ClientError('connectTimeout', 'Timed out connecting to OBS websocket'),
    );
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(screen.getByText('Timed out connecting to OBS.')).toBeTruthy();
    });
  });

  it('localizes unknown non-error OBS failures', async () => {
    obsMocks.client.connect.mockRejectedValueOnce('nope');
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(screen.getByText('OBS request failed.')).toBeTruthy();
    });
  });

  it('rejects non-websocket OBS URLs before constructing a client', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.change(screen.getByLabelText('OBS websocket URL'), { target: { value: 'http://127.0.0.1:4455' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));

    await waitFor(() => {
      expect(screen.getByText('Use a ws:// or wss:// URL for OBS.')).toBeTruthy();
    });
    expect(obsMocks.constructor).not.toHaveBeenCalled();
    expect(obsMocks.client.connect).not.toHaveBeenCalled();
  });

  it('connects automatically when starting from a disconnected state and writes the overlay first', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });
    expect(obsMocks.client.connect).toHaveBeenCalled();
    expect(obsMocks.client.setInputSettings.mock.invocationCallOrder[0]).toBeLessThan(
      obsMocks.client.startRecording.mock.invocationCallOrder[0],
    );
  });

  it('reacts to OBS record-state events from the websocket client', async () => {
    const onRecordingActiveChange = vi.fn();
    render(
      <ObsRecorderPanel currentClimbQueueItem={climbQueueItem} onRecordingActiveChange={onRecordingActiveChange} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect OBS' }));
    await waitFor(() => {
      expect(obsMocks.client.connect).toHaveBeenCalled();
    });

    const options = obsMocks.constructor.mock.calls[0][2] as unknown as {
      onRecordStateChanged: (event: { outputActive: boolean }) => void;
    };

    await act(async () => {
      options.onRecordStateChanged({ outputActive: true });
    });

    expect(onRecordingActiveChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByText('Recording: Moon Ladder / V5 / 40°')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      options.onRecordStateChanged({ outputActive: false });
    });

    expect(onRecordingActiveChange).toHaveBeenLastCalledWith(false);
    expect((screen.getByRole('button', { name: 'Disconnect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears the overlay after the start stamp timeout', async () => {
    vi.useFakeTimers();
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(obsMocks.client.startRecording).toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    expect(obsMocks.client.setInputSettings).toHaveBeenLastCalledWith('Boardsesh Climb Overlay', { text: '' }, true);
  });

  it('cancels the pending overlay timeout when stopping', async () => {
    vi.useFakeTimers();
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(obsMocks.client.startRecording).toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(obsMocks.client.stopRecording).toHaveBeenCalled();
    expect(obsMocks.client.setInputSettings).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(obsMocks.client.setInputSettings).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending overlay timeout when OBS reports recording inactive', async () => {
    vi.useFakeTimers();
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Start' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(obsMocks.client.startRecording).toHaveBeenCalled();

    const options = obsMocks.constructor.mock.calls[0][2] as unknown as {
      onRecordStateChanged: (event: { outputActive: boolean }) => void;
    };

    await act(async () => {
      options.onRecordStateChanged({ outputActive: false });
    });

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(obsMocks.client.setInputSettings).toHaveBeenCalledTimes(1);
  });

  it('keeps the active recording label on the snapped climb if the current climb changes', async () => {
    const nextClimbQueueItem: ClimbQueueItem = {
      ...climbQueueItem,
      uuid: 'queue-2',
      climb: {
        ...climbQueueItem.climb,
        uuid: 'climb-2',
        name: 'New Project',
        difficulty: 'V7',
      },
    };
    const { rerender } = render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });

    rerender(<ObsRecorderPanel currentClimbQueueItem={nextClimbQueueItem} />);

    expect(screen.getByText('Recording: Moon Ladder / V5 / 40°')).toBeTruthy();
  });

  it('resets the connection state when start cannot connect', async () => {
    obsMocks.client.connect.mockRejectedValueOnce(new Error('No OBS'));
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(screen.getByText('No OBS')).toBeTruthy();
    });
    expect(obsMocks.client.disconnect).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Connect OBS' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps recording controls available when stop fails', async () => {
    obsMocks.client.stopRecording.mockRejectedValueOnce(new Error('Stop failed'));
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Stop failed')).toBeTruthy();
    });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Fail' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('clears a stale output path when a later stop attempt fails', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByText('/videos/Moon Ladder.mp4')).toBeTruthy();
    });

    obsMocks.client.stopRecording.mockRejectedValueOnce(new Error('Stop failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Stop failed')).toBeTruthy();
    });
    expect(screen.queryByText('/videos/Moon Ladder.mp4')).toBeNull();
  });

  it('treats a not-recording stop response as an idle reset', async () => {
    obsMocks.client.stopRecording.mockRejectedValueOnce(new Error('Output not running'));
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('OBS is no longer recording')).toBeTruthy();
    });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('stops a successful recording as a failed attempt', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Fail' }));

    await waitFor(() => {
      expect(obsMocks.client.stopRecording).toHaveBeenCalled();
    });
    expect(screen.getByText('Recording stopped as a failed attempt')).toBeTruthy();
    expect(screen.getByText('/videos/Moon Ladder.mp4')).toBeTruthy();
  });

  it('loads and persists non-secret recorder settings without storing the password', async () => {
    preferenceMocks.getPreference.mockResolvedValueOnce({
      url: 'ws://localhost:4456',
      password: 'old-secret',
      textSourceName: 'Climb Title',
    });
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    await waitFor(() => {
      expect((screen.getByLabelText('OBS websocket URL') as HTMLInputElement).value).toBe('ws://localhost:4456');
    });
    expect((screen.getByLabelText('OBS password') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Text source') as HTMLInputElement).value).toBe('Climb Title');
    expect(preferenceMocks.setPreference).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('OBS password'), { target: { value: 'new-secret' } });
    fireEvent.change(screen.getByLabelText('OBS websocket URL'), { target: { value: 'ws://localhost:4457' } });

    await waitFor(() => {
      expect(preferenceMocks.setPreference).toHaveBeenLastCalledWith('obsRecorderSettings', {
        url: 'ws://localhost:4457',
        textSourceName: 'Climb Title',
      });
    });
    expect(preferenceMocks.setPreference).not.toHaveBeenCalledWith(
      'obsRecorderSettings',
      expect.objectContaining({ password: expect.anything() }),
    );
  });

  it('does not overwrite user-edited settings when stored settings resolve later', async () => {
    const storedSettings = deferred<unknown>();
    preferenceMocks.getPreference.mockReturnValueOnce(storedSettings.promise);
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    const urlInput = screen.getByLabelText('OBS websocket URL') as HTMLInputElement;
    const passwordInput = screen.getByLabelText('OBS password') as HTMLInputElement;
    const textSourceInput = screen.getByLabelText('Text source') as HTMLInputElement;

    expect(urlInput.disabled).toBe(true);
    expect(passwordInput.disabled).toBe(true);
    expect(textSourceInput.disabled).toBe(true);

    fireEvent.change(urlInput, { target: { value: 'ws://user-edit:4455' } });
    fireEvent.change(passwordInput, { target: { value: 'typed-secret' } });
    fireEvent.change(textSourceInput, { target: { value: 'User Source' } });

    await act(async () => {
      storedSettings.resolve({
        url: 'ws://stored:4455',
        textSourceName: 'Stored Source',
      });
      await storedSettings.promise;
    });

    expect(urlInput.disabled).toBe(false);
    expect(passwordInput.disabled).toBe(false);
    expect(textSourceInput.disabled).toBe(false);
    expect(urlInput.value).toBe('ws://user-edit:4455');
    expect(passwordInput.value).toBe('typed-secret');
    expect(textSourceInput.value).toBe('User Source');
  });

  it('skips overlay writes when the text source is blank', async () => {
    render(<ObsRecorderPanel currentClimbQueueItem={climbQueueItem} />);

    fireEvent.change(screen.getByLabelText('Text source'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    await waitFor(() => {
      expect(obsMocks.client.startRecording).toHaveBeenCalled();
    });
    expect(obsMocks.client.setInputSettings).not.toHaveBeenCalled();
  });

  it('disables start when there is no current climb', () => {
    render(<ObsRecorderPanel currentClimbQueueItem={null} />);

    expect(screen.getByText('No climb selected')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
