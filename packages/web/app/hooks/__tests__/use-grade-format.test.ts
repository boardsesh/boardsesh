import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useGradeFormat } from '../use-grade-format';

const mockGetFormat = vi.fn().mockResolvedValue('v-grade' as 'v-grade' | 'font' | null);
let mockLanguage = 'en-US';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: mockLanguage } }),
}));
const mockSetFormat = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/lib/user-preferences-db', () => ({
  getGradeDisplayFormat: () => mockGetFormat(),
  setGradeDisplayFormat: (f: string) => mockSetFormat(f),
}));

vi.mock('@/app/lib/grade-colors', () => ({
  formatGrade: (d: string | null | undefined, format: string) => (d ? `${format}:${d}` : null),
  getSoftGradeColorByFormat: (d: string | null | undefined, format: string) => (d ? `color:${format}:${d}` : undefined),
}));

describe('useGradeFormat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLanguage = 'en-US';
    mockGetFormat.mockResolvedValue('v-grade');
    mockSetFormat.mockResolvedValue(undefined);
  });

  it('defaults to v-grade and loaded=false before IndexedDB resolves', () => {
    mockGetFormat.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useGradeFormat());

    expect(result.current.gradeFormat).toBe('v-grade');
    expect(result.current.loaded).toBe(false);
  });

  it('sets loaded=true after IndexedDB resolves', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.gradeFormat).toBe('v-grade');
  });

  it('loads font format from IndexedDB when stored', async () => {
    mockGetFormat.mockResolvedValue('font');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.gradeFormat).toBe('font');
  });

  it('formatGrade delegates with current format', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.formatGrade('6a/V3')).toBe('v-grade:6a/V3');
    expect(result.current.formatGrade(null)).toBeNull();
  });

  it('getGradeColor delegates with current format', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.getGradeColor('6a/V3')).toBe('color:v-grade:6a/V3');
    expect(result.current.getGradeColor(null)).toBeUndefined();
  });

  it('setGradeFormat persists and updates state', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.gradeFormat).toBe('v-grade');

    await act(async () => {
      await result.current.setGradeFormat('font');
    });

    expect(mockSetFormat).toHaveBeenCalledWith('font');
    expect(result.current.gradeFormat).toBe('font');
  });

  it('setGradeFormat dispatches CustomEvent for cross-component sync', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    const events: CustomEvent[] = [];
    const listener = (e: Event) => {
      events.push(e as CustomEvent);
    };
    window.addEventListener('boardsesh:gradeFormatChange', listener);

    await act(async () => {
      await result.current.setGradeFormat('font');
    });

    window.removeEventListener('boardsesh:gradeFormatChange', listener);

    expect(events).toHaveLength(1);
    expect(events[0].detail).toBe('font');
  });

  it('CustomEvent from another source updates state', async () => {
    mockGetFormat.mockResolvedValue('v-grade');

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    expect(result.current.gradeFormat).toBe('v-grade');

    act(() => {
      window.dispatchEvent(new CustomEvent('boardsesh:gradeFormatChange', { detail: 'font' }));
    });

    expect(result.current.gradeFormat).toBe('font');
  });

  it('sets loaded=true even when IndexedDB rejects', async () => {
    mockGetFormat.mockRejectedValue(new Error('IndexedDB unavailable'));

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });

    // Falls back to default v-grade
    expect(result.current.gradeFormat).toBe('v-grade');
  });

  it.each(['es', 'fr', 'de', 'it'])('defaults %s pages to Font when nothing is picked', async (language) => {
    mockGetFormat.mockResolvedValue(null);
    mockLanguage = language;

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.gradeFormat).toBe('font');
  });

  it('keeps a picked V-grade on a Spanish page', async () => {
    mockGetFormat.mockResolvedValue('v-grade');
    mockLanguage = 'es';

    const { result } = renderHook(() => useGradeFormat());

    await waitFor(() => {
      expect(result.current.loaded).toBe(true);
    });
    expect(result.current.gradeFormat).toBe('v-grade');
  });
});
