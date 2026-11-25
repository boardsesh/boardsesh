import { describe, expect, it } from 'vitest';
import { boardFlowTicket, claimBoardFlowAbandonment, noteBoardFlowSecured } from '../board-create-flow';

// One `Board Builder Abandoned` per create flow (#8151): where, find-wall and
// the builder stack up, and all unmount when the modal closes.
describe('board create flow abandonment', () => {
  it('lets the deepest screen report and keeps the ones under it quiet', () => {
    const where = boardFlowTicket();
    const find = boardFlowTicket();
    const builder = boardFlowTicket();
    expect(claimBoardFlowAbandonment(builder)).toBe(true);
    expect(claimBoardFlowAbandonment(find)).toBe(false);
    expect(claimBoardFlowAbandonment(where)).toBe(false);
  });

  it('keeps every screen quiet once a board is secured', () => {
    const where = boardFlowTicket();
    const find = boardFlowTicket();
    noteBoardFlowSecured();
    expect(claimBoardFlowAbandonment(find)).toBe(false);
    expect(claimBoardFlowAbandonment(where)).toBe(false);
  });

  it('reports a screen that backs out on its own', () => {
    const find = boardFlowTicket();
    expect(claimBoardFlowAbandonment(find)).toBe(true);
  });

  it('reopens the flow when a secured bind is taken back', () => {
    const find = boardFlowTicket();
    const undo = noteBoardFlowSecured();
    undo();
    expect(claimBoardFlowAbandonment(find)).toBe(true);
  });

  it('starts a new flow clean after the last one ended', () => {
    noteBoardFlowSecured();
    const builder = boardFlowTicket();
    expect(claimBoardFlowAbandonment(builder)).toBe(true);
  });
});
