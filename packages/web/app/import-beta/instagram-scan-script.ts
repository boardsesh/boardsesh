/**
 * The console script users paste on instagram.com to scrape a profile's posts.
 *
 * Why a console script and not server-side: Instagram blocks server/datacenter
 * fetches and its API needs the logged-in session. This runs same-origin on
 * instagram.com using the user's own session, paginates the v1 feed API, and
 * copies a compact JSON array of { shortcode, caption, takenAt } to the
 * clipboard for pasting into the Boardsesh import page. No credentials leave
 * the browser; Boardsesh never touches Instagram.
 *
 * Hardened from a live scan of a 233-post account:
 *  - Retries transient failures (timeouts, the occasional 429/5xx) instead of
 *    stopping on the first error. A naive break-on-error silently truncates the
 *    scan, which under-reports what's missing — the whole point is to find ALL
 *    of it.
 *  - Logs running progress (a large account can take a minute to paginate).
 *  - Reports whether the scan COMPLETED or gave up early, so a partial result
 *    isn't mistaken for the full account.
 *
 * Exported as a string so the import page can display it with a copy button.
 */
export const INSTAGRAM_SCAN_SCRIPT = String.raw`(async () => {
  const APP_ID = '936619743392459';
  let userId = null;
  for (const s of document.querySelectorAll('script[type="application/json"]')) {
    const m = (s.textContent || '').match(/"user_id":"(\d+)"/) || (s.textContent || '').match(/"profilePage_(\d+)"/);
    if (m) { userId = m[1]; break; }
  }
  if (!userId) {
    const meta = document.querySelector('meta[property="al:ios:url"]');
    const m = meta && meta.content && meta.content.match(/id=(\d+)/);
    if (m) userId = m[1];
  }
  if (!userId) { alert('Boardsesh: open an Instagram PROFILE page first, then run this.'); return; }

  const seen = new Set();
  const out = [];
  let maxId = '';
  let complete = false;
  let consecutiveErrors = 0;
  const MAX_ERRORS = 6;
  const MAX_PAGES = 400;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = 'https://www.instagram.com/api/v1/feed/user/' + userId + '/?count=33' + (maxId ? '&max_id=' + maxId : '');
    let data = null;
    try {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined;
      const r = await fetch(url, { headers: { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include', signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
      if (!data || data.status !== 'ok') throw new Error('unexpected response');
    } catch (e) {
      consecutiveErrors++;
      console.log('Boardsesh scan: transient error (' + consecutiveErrors + '/' + MAX_ERRORS + '), retrying — ' + (e && e.message ? e.message : e));
      if (consecutiveErrors >= MAX_ERRORS) break; // give up; scan is incomplete
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    consecutiveErrors = 0;
    for (const it of (data.items || [])) {
      if (!it.code || seen.has(it.code)) continue;
      seen.add(it.code);
      out.push({ shortcode: it.code, caption: (it.caption && it.caption.text) || '', takenAt: it.taken_at || null });
    }
    console.log('Boardsesh scan: ' + out.length + ' posts so far...');
    if (!data.more_available) { complete = true; break; }
    maxId = data.next_max_id || '';
    if (!maxId) { complete = true; break; }
    await new Promise((res) => setTimeout(res, 300));
  }

  const json = JSON.stringify(out);
  // Stash on window so it's always retrievable with the DevTools copy() helper.
  // clipboard.writeText usually fails from a pasted console snippet (no user
  // gesture / DevTools has focus), and hand-copying a large JSON blob out of the
  // console is painful — copy(__boardseshBeta) is reliable everywhere.
  window.__boardseshBeta = json;
  const status = complete ? 'complete' : 'INCOMPLETE — hit repeated errors; re-run to get the rest';
  const summary = 'Boardsesh: ' + out.length + ' posts (' + status + ').';
  try {
    await navigator.clipboard.writeText(json);
    alert(summary + ' Copied to clipboard — paste it into the Boardsesh import page.');
  } catch (e) {
    console.log('%cBoardsesh: clipboard blocked. Run this in the console to copy it:  copy(__boardseshBeta)', 'font-weight:bold');
    alert(summary + ' Clipboard was blocked. In the console, run  copy(__boardseshBeta)  to copy it, then paste into Boardsesh.');
  }
})();`;
