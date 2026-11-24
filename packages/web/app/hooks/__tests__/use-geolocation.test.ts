import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGeolocation, getGeolocationErrorMessage } from '../use-geolocation';

// Helper to create a mock GeolocationPositionError
function createPositionError(code: number, message = ''): GeolocationPositionError {
  return {
    code,
    message,
    PERMISSION_DENIED: 1,
    POSITION_UNAVAILABLE: 2,
    TIMEOUT: 3,
  };
}

// Helper to create a mock GeolocationPosition
function createPosition(latitude: number, longitude: number, accuracy: number): GeolocationPosition {
  const coords: GeolocationCoordinates = {
    latitude,
    longitude,
    accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
    toJSON() {
      return {
        latitude,
        longitude,
        accuracy,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      };
    },
  };
  const timestamp = Date.now();
  return {
    coords,
    timestamp,
    toJSON() {
      return { coords, timestamp };
    },
  };
}

describe('useGeolocation', () => {
  let mockGetCurrentPosition: ReturnType<typeof vi.fn>;
  let mockPermissionQuery: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetCurrentPosition = vi.fn();
    mockPermissionQuery = vi.fn();

    // Set up geolocation mock
    Object.defineProperty(navigator, 'geolocation', {
      value: {
        getCurrentPosition: mockGetCurrentPosition,
      },
      writable: true,
      configurable: true,
    });

    // Set up permissions mock
    Object.defineProperty(navigator, 'permissions', {
      value: {
        query: mockPermissionQuery,
      },
      writable: true,
      configurable: true,
    });

    // Default: permissions query returns 'prompt'
    mockPermissionQuery.mockResolvedValue({
      state: 'prompt',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has correct initial state', () => {
    const { result } = renderHook(() => useGeolocation());

    expect(result.current.coordinates).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.permissionState).toBeNull();
  });

  it('requestPermission sets loading then resolves with coordinates', async () => {
    const mockPosition = createPosition(51.5074, -0.1278, 10);
    mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
      success(mockPosition);
    });

    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.coordinates).toEqual({
      latitude: 51.5074,
      longitude: -0.1278,
      accuracy: 10,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.permissionState).toBe('granted');
  });

  it('accepts approximate coordinates without requesting high accuracy', async () => {
    mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
      success(createPosition(52.36, 4.9, 5000));
    });
    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.permissionState).toBe('granted');
    expect(result.current.coordinates).toEqual({ latitude: 52.36, longitude: 4.9, accuracy: 5000 });
    expect(mockGetCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ enableHighAccuracy: false }),
    );
  });

  it('requestPermission handles permission denied (error code 1)', async () => {
    const posError = createPositionError(1, 'User denied Geolocation');
    mockGetCurrentPosition.mockImplementation((_success: PositionCallback, error: PositionErrorCallback) => {
      error(posError);
    });

    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.coordinates).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(posError);
    expect(result.current.permissionState).toBe('denied');
  });

  it('requestPermission handles position unavailable', async () => {
    const posError = createPositionError(2, 'Position unavailable');
    mockGetCurrentPosition.mockImplementation((_success: PositionCallback, error: PositionErrorCallback) => {
      error(posError);
    });

    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.coordinates).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(posError);
    // permissionState should remain unchanged (not denied) for non-permission errors
    // The mount effect queries the permissions API which sets it to 'prompt'
    expect(result.current.permissionState).toBe('prompt');
  });

  it('checks permission state on mount when permissions API is available', async () => {
    mockPermissionQuery.mockResolvedValue({
      state: 'granted',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useGeolocation());

    await waitFor(() => {
      expect(result.current.permissionState).toBe('granted');
    });

    expect(mockPermissionQuery).toHaveBeenCalledWith({ name: 'geolocation' });
  });

  it('handles missing permissions API gracefully', async () => {
    Object.defineProperty(navigator, 'permissions', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation());

    // Wait a tick for effects to run
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Should remain null since permissions API is not available
    expect(result.current.permissionState).toBeNull();
  });

  it('handles missing geolocation API', async () => {
    Object.defineProperty(navigator, 'geolocation', {
      value: undefined,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(result.current.coordinates).toBeNull();
  });

  it('refresh delegates to requestPermission when not granted', async () => {
    // Permission state is not 'granted' (default is null from initial state)
    const mockPosition = createPosition(40.7128, -74.006, 15);
    mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
      success(mockPosition);
    });

    const { result } = renderHook(() => useGeolocation());

    await act(async () => {
      await result.current.refresh();
    });

    // Should have set permissionState to 'granted' via requestPermission path
    expect(result.current.permissionState).toBe('granted');
    expect(result.current.coordinates).toEqual({
      latitude: 40.7128,
      longitude: -74.006,
      accuracy: 15,
    });
  });

  it('refresh fetches directly when already granted', async () => {
    const mockPosition1 = createPosition(51.5074, -0.1278, 10);
    const mockPosition2 = createPosition(48.8566, 2.3522, 5);

    // First call returns position 1
    mockGetCurrentPosition.mockImplementationOnce((success: PositionCallback) => {
      success(mockPosition1);
    });

    const { result } = renderHook(() => useGeolocation());

    // First, grant permission
    await act(async () => {
      await result.current.requestPermission();
    });

    expect(result.current.permissionState).toBe('granted');

    // Second call returns position 2
    mockGetCurrentPosition.mockImplementationOnce((success: PositionCallback) => {
      success(mockPosition2);
    });

    // Now refresh should take the direct path
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.coordinates).toEqual({
      latitude: 48.8566,
      longitude: 2.3522,
      accuracy: 5,
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('refresh handles errors when already granted', async () => {
    const mockPosition = createPosition(51.5074, -0.1278, 10);
    mockGetCurrentPosition.mockImplementationOnce((success: PositionCallback) => {
      success(mockPosition);
    });

    const { result } = renderHook(() => useGeolocation());

    // Grant permission first
    await act(async () => {
      await result.current.requestPermission();
    });

    // Now make the next call fail
    const posError = createPositionError(2, 'Position unavailable');
    mockGetCurrentPosition.mockImplementationOnce((_success: PositionCallback, error: PositionErrorCallback) => {
      error(posError);
    });

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(posError);
  });

  it('permission state changes via event listener', async () => {
    let changeHandler: (() => void) | null = null;
    const permissionStatus = {
      state: 'prompt' as PermissionState,
      addEventListener: vi.fn((_event: string, handler: () => void) => {
        changeHandler = handler;
      }),
      removeEventListener: vi.fn(),
    };
    mockPermissionQuery.mockResolvedValue(permissionStatus);

    const { result } = renderHook(() => useGeolocation());

    await waitFor(() => {
      expect(result.current.permissionState).toBe('prompt');
    });

    // Simulate permission state change
    permissionStatus.state = 'granted';
    act(() => {
      changeHandler!();
    });

    expect(result.current.permissionState).toBe('granted');
  });

  it('custom options are passed to getCurrentPosition', async () => {
    const customOptions: PositionOptions = {
      enableHighAccuracy: false,
      timeout: 5000,
      maximumAge: 0,
    };

    const mockPosition = createPosition(0, 0, 100);
    mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
      success(mockPosition);
    });

    const { result } = renderHook(() => useGeolocation(customOptions));

    await act(async () => {
      await result.current.requestPermission();
    });

    expect(mockGetCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), customOptions);
  });

  it('loading state is set correctly during async operations', async () => {
    let resolvePosition: ((pos: GeolocationPosition) => void) | null = null;
    mockGetCurrentPosition.mockImplementation((success: PositionCallback) => {
      resolvePosition = success;
    });

    const { result } = renderHook(() => useGeolocation());

    // Initially not loading
    expect(result.current.loading).toBe(false);

    // Start requesting - this will set loading to true
    let requestPromise: Promise<void>;
    act(() => {
      requestPromise = result.current.requestPermission();
    });

    // Should be loading now
    expect(result.current.loading).toBe(true);

    // Resolve the position
    const mockPosition = createPosition(51.5074, -0.1278, 10);
    await act(async () => {
      resolvePosition!(mockPosition);
      await requestPromise!;
    });

    // Should no longer be loading
    expect(result.current.loading).toBe(false);
  });
});

describe('getGeolocationErrorMessage', () => {
  it('returns correct message for PERMISSION_DENIED', () => {
    const error = createPositionError(1);
    const message = getGeolocationErrorMessage(error);
    expect(message).toBe('Location permission was denied. Please enable location access in your browser settings.');
  });

  it('returns correct message for POSITION_UNAVAILABLE', () => {
    const error = createPositionError(2);
    const message = getGeolocationErrorMessage(error);
    expect(message).toBe('Location information is unavailable. Please try again later.');
  });

  it('returns correct message for TIMEOUT', () => {
    const error = createPositionError(3);
    const message = getGeolocationErrorMessage(error);
    expect(message).toBe('Location request timed out. Please try again.');
  });

  it('returns correct message for unknown error code', () => {
    const error = createPositionError(99);
    const message = getGeolocationErrorMessage(error);
    expect(message).toBe('An unknown error occurred while getting your location.');
  });
});
