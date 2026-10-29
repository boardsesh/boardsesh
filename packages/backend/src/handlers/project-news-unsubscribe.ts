// One-click unsubscribe for project news email (docs/project-news-email.md).
//
//   GET  /api/project-news/unsubscribe?token=<token>  → a page with one button
//   POST /api/project-news/unsubscribe?token=<token>  → switches it off
//
// The token is the credential, so no sign-in is needed. POST is what switches
// email off: the button on the GET page posts back to the same URL, and mail
// apps send `List-Unsubscribe=One-Click` to it (RFC 8058). A GET never changes
// anything, because mail scanners and link previews fetch every link in an
// email and would otherwise unsubscribe people who never clicked.

import type { IncomingMessage, ServerResponse } from 'http';
import { setProjectNewsEmailConsent } from '../services/project-news-email';
import {
  verifyProjectNewsUnsubscribeToken,
  type UnsubscribeTokenFailure,
} from '../services/project-news-unsubscribe-token';
import { webPublicUrl } from '../email/email-service';
import { logger } from '../utils/logger';

const PAGE_STYLE =
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#292524;background:#fff}' +
  'h1{font-size:1.4rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:0;background:#292524;color:#fff;cursor:pointer}' +
  'a{color:#8b5cf6}@media (prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}button{background:#f5f5f4;color:#1c1917}}';

function sendPage(req: IncomingMessage, res: ServerResponse, statusCode: number, title: string, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    // The token is in the URL: never hand it to another site in a Referer.
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<title>${title}</title><style>${PAGE_STYLE}</style></head><body><h1>${title}</h1>${body}</body></html>`,
  );
}

function settingsLink(): string {
  return `<a href="${webPublicUrl()}/settings">Settings</a>`;
}

function sendInvalid(req: IncomingMessage, res: ServerResponse, reason: UnsubscribeTokenFailure): void {
  if (reason === 'not_configured') {
    sendPage(
      req,
      res,
      503,
      'Unsubscribe is down right now',
      `<p>Try the link again later, or switch off project news email in ${settingsLink()} or in the app under Settings, Account.</p>`,
    );
    return;
  }
  const lead = reason === 'expired' ? 'This unsubscribe link has expired.' : 'This unsubscribe link does not work.';
  sendPage(
    req,
    res,
    400,
    'Link not valid',
    `<p>${lead} You can switch off project news email in ${settingsLink()} or in the app under Settings, Account.</p>`,
  );
}

export async function handleProjectNewsUnsubscribe(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  // The one-click body (`List-Unsubscribe=One-Click`) says nothing the URL
  // doesn't; drain it so the connection can be reused.
  if (req.method === 'POST') req.resume();
  const verification = verifyProjectNewsUnsubscribeToken(url.searchParams.get('token'));
  if (!verification.ok) {
    sendInvalid(req, res, verification.reason);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    // An empty form action posts back to this exact URL, token included,
    // without echoing the token into the page.
    sendPage(
      req,
      res,
      200,
      'Stop project news email?',
      `<p>You will stop getting the occasional email about what's new in Boardsesh. Nothing else about your account changes.</p>` +
        `<form method="post" action=""><button type="submit">Unsubscribe</button></form>`,
    );
    return;
  }

  try {
    await setProjectNewsEmailConsent(verification.userId, false, 'email_link');
  } catch (error) {
    logger.error('[ProjectNews] Unsubscribe failed:', error);
    sendPage(
      req,
      res,
      500,
      'Something went wrong',
      `<p>We could not unsubscribe you just now. Try again, or switch it off in ${settingsLink()}.</p>`,
    );
    return;
  }
  sendPage(
    req,
    res,
    200,
    "You're unsubscribed",
    `<p>No more project news email. You can turn it back on any time in ${settingsLink()} or in the app under Settings, Account.</p>`,
  );
}
