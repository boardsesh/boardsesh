import { describe, it, expect } from 'vite-plus/test';
import {
  type ClimbActionType,
  DEFAULT_ACTION_ORDER,
  ACTION_SHEET_ACTION_ORDER,
  AUTH_REQUIRED_ACTIONS,
  AURORA_CREDENTIALS_REQUIRED_ACTIONS,
} from '../types';

describe('Climb Action Types & Constants', () => {
  describe('DEFAULT_ACTION_ORDER', () => {
    it('contains all 11 default action types', () => {
      expect(DEFAULT_ACTION_ORDER).toHaveLength(11);
    });

    it('has correct ordering', () => {
      expect(DEFAULT_ACTION_ORDER[0]).toBe('mirror');
      expect(DEFAULT_ACTION_ORDER[DEFAULT_ACTION_ORDER.length - 1]).toBe('openInApp');
    });

    it('contains all expected action types', () => {
      const expectedActions: ClimbActionType[] = [
        'viewDetails',
        'fork',
        'favorite',
        'setActive',
        'queue',
        'goToQueue',
        'tick',
        'share',
        'playlist',
        'openInApp',
        'mirror',
      ];
      for (const action of expectedActions) {
        expect(DEFAULT_ACTION_ORDER).toContain(action);
      }
    });

    it('has no duplicates', () => {
      const unique = new Set(DEFAULT_ACTION_ORDER);
      expect(unique.size).toBe(DEFAULT_ACTION_ORDER.length);
    });
  });

  describe('ACTION_SHEET_ACTION_ORDER', () => {
    it('contains add beta video in the full sheet order', () => {
      expect(ACTION_SHEET_ACTION_ORDER).toHaveLength(12);
      expect(ACTION_SHEET_ACTION_ORDER).toContain('addBetaVideo');
      expect(ACTION_SHEET_ACTION_ORDER.indexOf('addBetaVideo')).toBeGreaterThan(
        ACTION_SHEET_ACTION_ORDER.indexOf('share'),
      );
      expect(ACTION_SHEET_ACTION_ORDER.indexOf('addBetaVideo')).toBeLessThan(
        ACTION_SHEET_ACTION_ORDER.indexOf('favorite'),
      );
    });
  });

  describe('AUTH_REQUIRED_ACTIONS', () => {
    it('contains actions that require a Boardsesh account', () => {
      expect(AUTH_REQUIRED_ACTIONS).toHaveLength(3);
      expect(AUTH_REQUIRED_ACTIONS).toContain('favorite');
      expect(AUTH_REQUIRED_ACTIONS).toContain('playlist');
      expect(AUTH_REQUIRED_ACTIONS).toContain('addBetaVideo');
    });

    it('does not contain actions that do not require auth', () => {
      expect(AUTH_REQUIRED_ACTIONS).not.toContain('viewDetails');
      expect(AUTH_REQUIRED_ACTIONS).not.toContain('fork');
      expect(AUTH_REQUIRED_ACTIONS).not.toContain('queue');
      expect(AUTH_REQUIRED_ACTIONS).not.toContain('tick');
      expect(AUTH_REQUIRED_ACTIONS).not.toContain('share');
    });
  });

  describe('AURORA_CREDENTIALS_REQUIRED_ACTIONS', () => {
    it('contains exactly tick', () => {
      expect(AURORA_CREDENTIALS_REQUIRED_ACTIONS).toHaveLength(1);
      expect(AURORA_CREDENTIALS_REQUIRED_ACTIONS).toContain('tick');
    });
  });
});
