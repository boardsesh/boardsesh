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
  while (true) {
    const url = 'https://www.instagram.com/api/v1/feed/user/' + userId + '/?count=33' + (maxId ? '&max_id=' + maxId : '');
    let data;
    try {
      const r = await fetch(url, { headers: { 'X-IG-App-ID': APP_ID, 'X-Requested-With': 'XMLHttpRequest' }, credentials: 'include' });
      if (!r.ok) break;
      data = await r.json();
    } catch (e) { break; }
    if (!data || data.status !== 'ok') break;
    for (const it of (data.items || [])) {
      if (!it.code || seen.has(it.code)) continue;
      seen.add(it.code);
      out.push({ shortcode: it.code, caption: (it.caption && it.caption.text) || '', takenAt: it.taken_at || null });
    }
    console.log('Boardsesh scan: ' + out.length + ' posts so far...');
    if (!data.more_available) break;
    maxId = data.next_max_id || '';
    if (!maxId) break;
    await new Promise((res) => setTimeout(res, 300));
  }

  const json = JSON.stringify(out);
  try {
    await navigator.clipboard.writeText(json);
    alert('Boardsesh: copied ' + out.length + ' posts. Paste them into the Boardsesh import page.');
  } catch (e) {
    console.log('Boardsesh scan JSON (clipboard blocked — copy the next line):');
    console.log(json);
    alert('Boardsesh: clipboard blocked. Copy the JSON printed in the console.');
  }
})();`;
