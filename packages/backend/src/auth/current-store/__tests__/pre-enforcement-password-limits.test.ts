import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { createPasswordLoginLimiter } from '../password-login-limits';
import { resetAllRateLimits } from '../../../utils/rate-limiter';

afterEach(() => {
  vi.useRealTimers();
  resetAllRateLimits();
});
describe('new default password proof actual Redis custody', () => {
  it.each(['resolve', 'reject'] as const)(
    'retains capacity through timed-out eval/refund and late %s',
    async (settlement) => {
      vi.useFakeTimers();
      let finishEval!: (reply: number) => void;
      let rejectEval!: (error: Error) => void;
      let rejectRefund!: (error: Error) => void;
      let finishRefund!: (reply: number) => void;
      const evalCall = vi.fn(
        () =>
          new Promise<number>((resolve, reject) => {
            finishEval = resolve;
            rejectEval = reject;
          }),
      );
      const refundCall = vi.fn(
        () =>
          new Promise<number>((resolve, reject) => {
            finishRefund = resolve;
            rejectRefund = reject;
          }),
      );
      const limiter = createPasswordLoginLimiter({
        redis: () => ({ eval: evalCall, hdel: refundCall }),
        maxPendingRedisCommands: 1,
      });
      const initial = limiter.admit({ clientAddress: '8.8.8.8' });
      await vi.advanceTimersByTimeAsync(101);
      const admitted = await initial;
      for (let index = 1; index <= 12; index++) await limiter.admit({ clientAddress: `8.8.4.${index}` });
      expect(evalCall).toHaveBeenCalledTimes(1);
      expect(refundCall).not.toHaveBeenCalled();
      if (settlement === 'resolve') finishEval(0);
      else rejectEval(new Error('late eval failure'));
      await vi.advanceTimersByTimeAsync(0);
      const refund = admitted.giveBack();
      await vi.advanceTimersByTimeAsync(101);
      await refund;
      expect(refundCall).toHaveBeenCalledTimes(1);
      await limiter.admit({ clientAddress: '1.1.1.1' });
      expect(evalCall).toHaveBeenCalledTimes(1);
      if (settlement === 'resolve') finishRefund(1);
      else rejectRefund(new Error('late refund failure'));
      await vi.advanceTimersByTimeAsync(0);
      const next = limiter.admit({ clientAddress: '9.9.9.9' });
      expect(evalCall).toHaveBeenCalledTimes(2);
      finishEval(0);
      await next;
    },
  );
});
