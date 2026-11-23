import { describe, expect, it } from 'vite-plus/test';
import { buildReportReturnPath, readReportReturnKey, stripReportParam } from '../report-return-param';

describe('the ?report= return from sign-in', () => {
  it('adds the report to the page the climber was on, keeping its other params', () => {
    expect(buildReportReturnPath('/gym/crux', '', 'gym')).toBe('/gym/crux?report=gym');
    expect(buildReportReturnPath('/b/crux-kilter/40/list', '?page=2', 'abc-123')).toBe(
      '/b/crux-kilter/40/list?page=2&report=abc-123',
    );
    expect(buildReportReturnPath('/gym/crux', '?report=old', 'gym')).toBe('/gym/crux?report=gym');
  });

  it('reads one well-formed value and nothing else', () => {
    expect(readReportReturnKey('?report=gym')).toBe('gym');
    expect(readReportReturnKey('?report=0c7a7b1e-1f2b-4c3d-9e8f-001122334455')).toBe(
      '0c7a7b1e-1f2b-4c3d-9e8f-001122334455',
    );
    expect(readReportReturnKey('')).toBeNull();
    expect(readReportReturnKey('?report=gym&report=gym')).toBeNull();
    expect(readReportReturnKey('?report=%3Cscript%3E')).toBeNull();
    expect(readReportReturnKey(`?report=${'a'.repeat(65)}`)).toBeNull();
  });

  it('drops only the report param', () => {
    expect(stripReportParam('https://www.boardsesh.com/gym/crux?report=gym&src=qr#boards')).toBe(
      '/gym/crux?src=qr#boards',
    );
    expect(stripReportParam('https://www.boardsesh.com/gym/crux?report=gym')).toBe('/gym/crux');
  });
});
