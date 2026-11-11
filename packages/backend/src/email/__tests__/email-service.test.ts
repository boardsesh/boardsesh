import { describe, expect, it, vi } from 'vite-plus/test';

const sendMail = vi.hoisted(() => vi.fn());
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));
import { sendGymClaimVerificationEmail } from '../email-service';

describe('backend retired-address delivery guard', () => {
  it('rejects .invalid recipients before connecting to SMTP', async () => {
    await expect(
      sendGymClaimVerificationEmail(
        'synthetic@retired.boardsesh.invalid',
        'synthetic-token',
        'Synthetic gym',
        'Synthetic climber',
      ),
    ).rejects.toThrow();
    await expect(
      sendGymClaimVerificationEmail(
        'synthetic@RETIRED.BOARDSESH.INVALID',
        'synthetic-token',
        'Synthetic gym',
        'Synthetic climber',
      ),
    ).rejects.toThrow();
    expect(sendMail).not.toHaveBeenCalled();
  });
});
