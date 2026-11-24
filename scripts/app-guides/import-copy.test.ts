import { describe, expect, it } from 'vite-plus/test';
import { countSentences, findClaims, importComparisonPage, importHubPage } from './import-copy-lib';

const source = (id: string) => ({
  id,
  label: `Source ${id}`,
  url: `https://example.com/${id}`,
  checkedAt: '2026-11-24',
});

function boardPage(overrides: (page: Record<string, unknown>) => void = () => {}) {
  const rows = [
    ['lighting', 'tie'],
    ['history', 'boardsesh'],
    ['crew', 'boardsesh'],
    ['training', 'boardsesh'],
    ['browser', 'only-boardsesh'],
    ['other-boards', 'boardsesh'],
    ['curated', 'official'],
  ].map(([id, verdict]) => ({
    id,
    feature: `Feature ${id}`,
    verdict,
    boardsesh: 'Boardsesh does this.',
    official: 'The official app does that.',
    sourceIds: ['kilter-site'],
  }));
  const page: Record<string, unknown> = {
    page: 'kilter',
    meta: {
      title: 'Kilter Board App Alternative: Boardsesh vs the Kilter App',
      description:
        'Boardsesh vs the Kilter Board app for Original and Homewall: what each does, how to bring your old logbook across, and when to keep Kilter app.',
    },
    hero: {
      pill: 'Works with Kilter',
      h1: 'Boardsesh vs the Kilter Board app',
      lead: 'Lead.',
      byline: 'A guide from Boardsesh.',
    },
    verdict: {
      heading: 'Which app fits?',
      pickIf: ['You climb.', 'Your crew queues.', 'You train.', 'You travel.', 'You use a laptop.'],
      keepIf: ['You set climbs.', 'You like curated lists.'],
      bottomLine: 'Keep both.',
    },
    only: {
      heading: 'Where it differs',
      lead: 'Three things.',
      tiles: ['history', 'browser', 'one-logbook'].map((id) => ({
        id,
        title: id,
        body: 'Body.',
        sourceIds: ['kilter-site'],
      })),
    },
    comparison: { heading: 'Side by side', lead: 'Checked.', rows },
    session: {
      heading: 'An evening',
      steps: ['pick', 'queue', 'climb', 'log'].map((id) => ({
        id,
        title: id,
        body: 'One sentence.',
        screenshot: 'logbook',
      })),
    },
    logbook: {
      heading: 'Bring your logbook',
      lead: 'Lead.',
      paths: [{ id: 'account', title: 'Account', subtitle: 'Now', steps: ['One.', 'Two.', 'Three.'] }],
    },
    faq: {
      heading: 'Questions',
      items: ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, q: `Question ${id}?`, a: 'Yes. It does.' })),
    },
    method: { heading: 'How we compared', body: 'Body.' },
    cta: { heading: 'Light it', body: 'Free.' },
    sources: [source('kilter-site')],
  };
  overrides(page);
  return page;
}

const rows = (page: Record<string, unknown>) => (page.comparison as { rows: Record<string, unknown>[] }).rows;
const errors = (result: ReturnType<typeof importComparisonPage>) =>
  result.issues.filter((issue) => issue.severity === 'error').map((issue) => `${issue.path} ${issue.message}`);

describe('import-copy', () => {
  it('imports a valid page into stable catalog keys and registry structure', () => {
    const result = importComparisonPage('kilter', boardPage(), { allowPending: false });
    expect(errors(result)).toEqual([]);
    expect(result.catalog.verdict).toMatchObject({
      pickIf: { p1: 'You climb.' },
      keepIf: { k2: 'You like curated lists.' },
    });
    expect(result.catalog.comparison).toMatchObject({ rows: { curated: { official: 'The official app does that.' } } });
    expect(result.registry).toMatchObject({
      id: 'kilter',
      hasByline: true,
      competitors: ['official'],
      sources: [{ id: 'kilter-site', url: 'https://example.com/kilter-site', checkedAt: '2026-11-24' }],
    });
    const registry = result.registry as unknown as { rows: { id: string; verdict: string; winners: string[] }[] };
    expect(registry.rows.find((row) => row.id === 'browser')?.verdict).toBe('only');
    expect(registry.rows.find((row) => row.id === 'curated')).toMatchObject({
      verdict: 'competitor',
      winners: ['official'],
    });
    // Text goes to the catalog, structure to the registry: no URLs, dates or verdicts in the text.
    expect(JSON.stringify(result.catalog)).not.toMatch(/https:\/\/|2026-11-24|only-boardsesh/);
    expect(result.catalog.sources).toEqual({ 'kilter-site': 'Source kilter-site' });
  });

  it('refuses [PENDING-…] text and source ids unless the run allows them', () => {
    const pending = boardPage((page) => {
      Object.assign(rows(page)[0], { official: '[PENDING-TABLET]', sourceIds: ['PENDING-TABLET'] });
    });
    expect(errors(importComparisonPage('kilter', pending, { allowPending: false }))).toEqual([
      expect.stringContaining('comparison.rows.lighting.official holds a placeholder'),
      expect.stringContaining('comparison.rows.lighting.sourceIds cites a placeholder source'),
    ]);
    const preview = importComparisonPage('kilter', pending, { allowPending: true });
    expect(errors(preview)).toEqual([]);
    expect(
      (preview.registry as unknown as { rows: { pendingCells: string[]; pending?: boolean }[] }).rows[0],
    ).toMatchObject({
      pendingCells: ['official'],
      pending: true,
    });
  });

  it('enforces verdict values, caps, counts and sources', () => {
    const broken = boardPage((page) => {
      rows(page)[0].verdict = 'better';
      rows(page)[1].boardsesh = 'x'.repeat(91);
      rows(page)[4].sourceIds = [];
      rows(page)[5].sourceIds = ['missing'];
      (page.verdict as { pickIf: string[] }).pickIf[0] = 'Crews love it.';
      (page.faq as { items: { a: string }[] }).items[0].a = 'One. Two. Three.';
      (page.session as { steps: { body: string }[] }).steps[0].body = 'One. Two.';
      (page.meta as { description: string }).description = 'Too short.';
      (page.only as { tiles: unknown[] }).tiles.splice(1);
    });
    const messages = errors(importComparisonPage('kilter', broken, { allowPending: false }));
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/rows\.lighting\.verdict "better" is not one of/),
        expect.stringMatching(/rows\.history\.boardsesh is 91 characters \(cap 90\)/),
        expect.stringMatching(/rows\.browser\.sourceIds an "only-boardsesh" row needs at least one source/),
        expect.stringMatching(/rows\.other-boards\.sourceIds cites unknown source "missing"/),
        expect.stringMatching(/pickIf\[0\] must start with the climber/),
        expect.stringMatching(/faq\.items\.a\.a has 3 sentences/),
        expect.stringMatching(/session\.steps\.pick\.body has 2 sentences/),
        expect.stringMatching(/meta\.description is 10 characters/),
        expect.stringMatching(/only\.tiles has 1 entries; expected 3 to 4/),
      ]),
    );
    // --draft turns every rule into a warning, for a dev preview only.
    expect(errors(importComparisonPage('kilter', broken, { allowPending: false, draft: true }))).toEqual([]);
  });

  it('accepts "unlisted": the other app does not document it, which is no win', () => {
    const page = boardPage((json) => {
      rows(json)[2].verdict = 'unlisted';
    });
    const result = importComparisonPage('kilter', page, { allowPending: false });
    expect(errors(result)).toEqual([]);
    expect((result.registry as unknown as { rows: { id: string; verdict: string }[] }).rows[2]).toMatchObject({
      id: 'crew',
      verdict: 'unlisted',
    });
    // An "unlisted" row is not the honesty row: a page still needs a tie or an official win.
    const allOurs = boardPage((json) => {
      for (const row of rows(json)) row.verdict = row.verdict === 'only-boardsesh' ? 'only-boardsesh' : 'unlisted';
    });
    expect(errors(importComparisonPage('kilter', allOurs, { allowPending: false }))).toContain(
      'comparison.rows needs at least one row the other app wins or ties',
    );
  });

  it('needs a row the official app wins or ties', () => {
    const allOurs = boardPage((page) => {
      for (const row of rows(page)) if (row.verdict === 'tie' || row.verdict === 'official') row.verdict = 'boardsesh';
    });
    expect(errors(importComparisonPage('kilter', allOurs, { allowPending: false }))).toContain(
      'comparison.rows needs at least one row the other app wins or ties',
    );
  });

  it('takes an open map of competitors on the spray page and names the winners', () => {
    const spray = boardPage((page) => {
      page.page = 'spray-wall-apps';
      for (const row of rows(page)) {
        delete row.official;
        row.competitors = { stokt: 'Stōkt cell.', retroFlash: 'Retro Flash cell.', crux: 'Crux cell.' };
        if (row.verdict === 'official') row.verdict = 'competitor';
      }
      rows(page)[6].id = 'community';
    });
    const result = importComparisonPage('spray-wall-apps', spray, { allowPending: false });
    expect(errors(result)).toEqual([]);
    expect(result.registry).toMatchObject({ competitors: ['stokt', 'crux', 'retroFlash'] });
    expect((result.registry as unknown as { rows: { id: string; winners: string[] }[] }).rows.at(-1)).toMatchObject({
      id: 'community',
      winners: ['stokt'],
    });
    rows(spray)[6].id = 'unlisted';
    expect(errors(importComparisonPage('spray-wall-apps', spray, { allowPending: false }))).toContain(
      'comparison.rows.unlisted.winners a "competitor" row must name which apps win (winners) or have one in COMPETITOR_WINNERS',
    );
    rows(spray)[6].winners = ['crux'];
    expect(errors(importComparisonPage('spray-wall-apps', spray, { allowPending: false }))).toEqual([]);
  });

  it('lets a Boardsesh win be shared with named competitors, and nowhere else', () => {
    const spray = boardPage((page) => {
      page.page = 'spray-wall-apps';
      for (const row of rows(page)) {
        delete row.official;
        row.competitors = { stokt: 'Stōkt cell.', retroFlash: 'Retro Flash cell.', crux: 'Crux cell.' };
        if (row.verdict === 'official') Object.assign(row, { verdict: 'competitor', winners: ['stokt'] });
      }
      rows(page)[1].sharedWith = ['crux'];
    });
    const result = importComparisonPage('spray-wall-apps', spray, { allowPending: false });
    expect(errors(result)).toEqual([]);
    const registry = result.registry as unknown as { rows: { id: string; sharedWith?: string[] }[] };
    expect(registry.rows[1]).toMatchObject({ id: 'history', sharedWith: ['crux'] });
    expect(registry.rows[0].sharedWith).toBeUndefined();

    rows(spray)[1].sharedWith = ['strava'];
    rows(spray)[0].sharedWith = ['crux'];
    expect(errors(importComparisonPage('spray-wall-apps', spray, { allowPending: false }))).toEqual([
      'comparison.rows.lighting.sharedWith is only allowed on a "boardsesh" row',
      'comparison.rows.history.sharedWith "strava" is not a competitor on this page',
    ]);
  });

  it("never lets a step borrow another board's screen", () => {
    const steps = (page: Record<string, unknown>) => (page.session as { steps: Record<string, unknown>[] }).steps;
    const woods = boardPage((page) => {
      page.page = 'woods';
      steps(page)[0].screenshot = 'board';
      steps(page)[1].screenshot = null;
      steps(page)[2].screenshot = 'logbook';
      steps(page)[3].screenshot = 'kilter';
    });
    expect(errors(importComparisonPage('woods', woods, { allowPending: false }))).toEqual([
      expect.stringMatching(/session\.steps\.log\.screenshot "kilter" shows another board or screen/),
    ]);
    steps(woods)[3].screenshot = 'queue';
    expect(errors(importComparisonPage('woods', woods, { allowPending: false }))).toHaveLength(1);
    steps(woods)[3].screenshot = 'profile';
    const result = importComparisonPage('woods', woods, { allowPending: false });
    expect(errors(result)).toEqual([]);
    expect(
      (result.registry as unknown as { steps: { screenshot: string | null }[] }).steps.map((step) => step.screenshot),
    ).toEqual(['board', null, 'logbook', 'profile']);
  });

  it('refuses a gated claim where the renderer could not hide it', () => {
    const claim = 'MoonBoard needs a Google-certified phone.';
    const kilter = boardPage((page) => {
      (page.hero as { lead: string }).lead = claim;
    });
    expect(errors(importComparisonPage('kilter', kilter, { allowPending: false }))).toEqual([
      "hero.lead makes the googleCertified claim where it can't be hidden; move it into a row, tile, FAQ or bullet",
    ]);
    const inRow = boardPage((page) => {
      rows(page)[0].official = claim;
    });
    expect(errors(importComparisonPage('kilter', inRow, { allowPending: false }))).toEqual([]);
  });

  it('tags the Google-certified contrast wherever the copy makes it', () => {
    expect(
      findClaims({
        comparison: {
          rows: { android: { boardsesh: 'Any Android 7+ phone.', official: 'Needs a Google-certified phone.' } },
        },
        faq: { items: { android: { q: 'Android?', a: "Boardsesh doesn't check for Google certification." } } },
      }),
    ).toEqual([{ path: 'comparison.rows.android', claim: 'googleCertified' }]);
  });

  it('wants hub tile links that name their board and point at the page that covers it', () => {
    const slugs = ['kilter', 'tension', 'moonboard', 'decoy', 'touchstone', 'grasshopper', 'so-ill', 'woods'];
    const hub = {
      page: 'hub',
      meta: boardPage().meta as object,
      hero: { pill: 'Pill', h1: 'One app', lead: 'Lead.' },
      boards: {
        heading: 'Pick your board',
        lead: 'Lead.',
        tiles: slugs.map((slug) => ({
          slug,
          name: `${slug} Board`,
          layouts: 'Layouts',
          linkText: `Compare ${slug} Board apps`,
        })),
        spray: { title: 'Spray', body: 'Body.', linkText: 'Compare spray wall apps' },
      },
      everyBoard: {
        heading: 'Every board',
        tiles: ['queue', 'workouts', 'logbook'].map((id) => ({ id, title: id, body: 'Body.' })),
      },
      devices: { heading: 'Devices', lead: 'Lead.', captions: { ios: 'iOS', android: 'Android', browser: 'Browser' } },
      numbers: { ratingLabel: 'Rating', climbersLabel: 'Climbers', climbsLabel: 'Climbs', freshness: 'Fresh.' },
      faq: boardPage().faq,
      method: { heading: 'How', body: 'Body.' },
      cta: { heading: 'Go', body: 'Free.' },
      sources: [source('boardsesh')],
    };
    expect(errors(importHubPage(hub, { allowPending: false }))).toEqual([]);
    // The "On every board" lead is optional; when present it reaches the catalog and the registry says so.
    expect(importHubPage(hub, { allowPending: false }).registry).toMatchObject({ everyBoardLead: false });
    const withLead = importHubPage(
      { ...hub, everyBoard: { ...hub.everyBoard, lead: 'Learn it once.' } },
      { allowPending: false },
    );
    expect(withLead.registry).toMatchObject({ everyBoardLead: true });
    expect(withLead.catalog.everyBoard).toMatchObject({ lead: 'Learn it once.' });
    // The makers' card is optional too: text to the catalog, the link to the registry, a www path only.
    expect(importHubPage(hub, { allowPending: false }).registry).toMatchObject({ makers: null });
    const makers = {
      title: 'Want your board here?',
      body: 'Talk to us.',
      linkText: 'Talk to us',
      href: '/for-gyms#partners',
    };
    const withMakers = importHubPage({ ...hub, boards: { ...hub.boards, makers } }, { allowPending: false });
    expect(errors(withMakers)).toEqual([]);
    expect(withMakers.registry).toMatchObject({ makers: { href: '/for-gyms#partners' } });
    expect(withMakers.catalog.boards).toMatchObject({
      makers: { title: 'Want your board here?', body: 'Talk to us.', linkText: 'Talk to us' },
    });
    const offSite = importHubPage(
      { ...hub, boards: { ...hub.boards, makers: { ...makers, href: 'https://example.com' } } },
      { allowPending: false },
    );
    expect(errors(offSite)).toEqual([expect.stringMatching(/boards\.makers\.href is "https:\/\/example\.com"/)]);
    const tiles = hub.boards.tiles as Record<string, string>[];
    tiles[0].linkText = 'Compare the apps';
    tiles[1].href = '/apps/tension';
    expect(errors(importHubPage(hub, { allowPending: false }))).toEqual([
      expect.stringMatching(/boards\.tiles\.kilter\.linkText must name the board/),
      expect.stringMatching(
        /boards\.tiles\.tension\.href is "\/apps\/tension"; the tension tile links to \/apps\/aurora#tension/,
      ),
    ]);
  });

  it('counts sentences without splitting decimals or domains', () => {
    expect(countSentences('Rated 1.8 from 23 ratings at app.boardsesh.com. Try it.')).toBe(2);
    expect(countSentences('One sentence only')).toBe(1);
  });
});
