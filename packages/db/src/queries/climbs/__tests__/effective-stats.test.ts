import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBrowsedAngleRestriction,
  resolveCrossAngleStats,
  resolveDetailCrossAngleStats,
} from '../effective-stats';
import { hasNameQuery, type BoardRouteParams } from '../types';

const woods: Pick<BoardRouteParams, 'board_name'> = { board_name: 'woods' };
const kilter: Pick<BoardRouteParams, 'board_name'> = { board_name: 'kilter' };
const moonboard: Pick<BoardRouteParams, 'board_name'> = { board_name: 'moonboard' };

// Issue #5642: the three decisions searchClimbs, countClimbs and getClimbByUuid
// read. List and count take the first two from the same helpers, so a table of
// their answers is the contract both queries are held to.
void describe('resolveCrossAngleStats', () => {
  void it('is off on Woods unless the search opts in — omitted and false alike', () => {
    assert.equal(resolveCrossAngleStats(woods, {}), false);
    assert.equal(resolveCrossAngleStats(woods, { crossAngleStats: false }), false);
    assert.equal(resolveCrossAngleStats(woods, { crossAngleStats: true }), true);
  });

  void it('turns on for a by-name search on Woods, whatever the opt-in says', () => {
    assert.equal(resolveCrossAngleStats(woods, { name: 'Crimp' }), true);
    assert.equal(resolveCrossAngleStats(woods, { name: 'Crimp', crossAngleStats: false }), true);
    // An empty name is no name, the same reading the community-hidden filter uses.
    assert.equal(resolveCrossAngleStats(woods, { name: '' }), false);
  });

  void it('leaves Kilter on the opt-in alone — a name search does not turn it on', () => {
    assert.equal(resolveCrossAngleStats(kilter, {}), false);
    assert.equal(resolveCrossAngleStats(kilter, { crossAngleStats: false }), false);
    assert.equal(resolveCrossAngleStats(kilter, { name: 'Crimp' }), false);
    assert.equal(resolveCrossAngleStats(kilter, { crossAngleStats: true }), true);
  });

  void it('treats MoonBoard like Kilter, because its capability is off', () => {
    assert.equal(resolveCrossAngleStats(moonboard, {}), false);
    assert.equal(resolveCrossAngleStats(moonboard, { name: 'Crimp' }), false);
    assert.equal(resolveCrossAngleStats(moonboard, { crossAngleStats: true }), true);
  });
});

void describe('resolveBrowsedAngleRestriction', () => {
  void it('restricts a Woods search that is not cross-angle', () => {
    assert.equal(resolveBrowsedAngleRestriction(woods, {}), true);
    assert.equal(resolveBrowsedAngleRestriction(woods, { crossAngleStats: false }), true);
  });

  void it('is the complement of cross-angle on Woods', () => {
    assert.equal(resolveBrowsedAngleRestriction(woods, { crossAngleStats: true }), false);
    assert.equal(resolveBrowsedAngleRestriction(woods, { name: 'Crimp' }), false);
  });

  void it('never restricts a board whose climbs are not angle-bound', () => {
    for (const board of [kilter, moonboard, { board_name: 'spray' } as const]) {
      assert.equal(resolveBrowsedAngleRestriction(board, {}), false);
      assert.equal(resolveBrowsedAngleRestriction(board, { crossAngleStats: false }), false);
      assert.equal(resolveBrowsedAngleRestriction(board, { crossAngleStats: true }), false);
    }
  });
});

void describe('resolveDetailCrossAngleStats', () => {
  // A Woods climb reached at another angle — a name search, an opted-in list, a
  // playlist — opens with its set-angle grade, not a blank one.
  void it('stays on for Woods and off for boards that are not angle-bound', () => {
    assert.equal(resolveDetailCrossAngleStats(woods), true);
    assert.equal(resolveDetailCrossAngleStats(kilter), false);
    assert.equal(resolveDetailCrossAngleStats(moonboard), false);
  });
});

void describe('hasNameQuery', () => {
  void it('counts only a non-empty string', () => {
    assert.equal(hasNameQuery({ name: 'Crimp' }), true);
    assert.equal(hasNameQuery({ name: '' }), false);
    assert.equal(hasNameQuery({}), false);
  });
});
