(function () {
  const GRADES = ['6A', '6A+', '6B', '6B+', '6C', '6C+', '7A', '7A+', '7B', '7B+', '7C', '7C+', '8A', '8A+', '8B'];
  const V = { '6A': 'V3', '6A+': 'V3', '6B': 'V4', '6B+': 'V4', '6C': 'V5', '6C+': 'V5', '7A': 'V6', '7A+': 'V7', '7B': 'V8', '7B+': 'V8', '7C': 'V9', '7C+': 'V10', '8A': 'V11', '8A+': 'V12', '8B': 'V13' };
  const BOARDS = {
    moon: { label: 'Moonboard 2024', rows: 18, cols: 11 },
    kilter: { label: 'Kilter Homewall', rows: 16, cols: 13 },
    tension: { label: 'Tension Board 2', rows: 18, cols: 12 },
  };
  const raw = [
    ['Crimp Lord', '6C+', 'Ben Moon', 1204, 3, true, 'Mar 2024'],
    ['Left Hand Path', '7A', 'Lena Park', 312, 2, false, 'Jun 2024'],
    ['Warm-up Ladder', '6A', 'Setter Team', 4810, 2, true, 'Jan 2024'],
    ['Pinch Me', '6B+', 'Sam Ortiz', 902, 3, false, 'Aug 2024'],
    ['Dyno-mite', '7B', 'Jo Ko', 188, 3, true, 'Feb 2025'],
    ['The Slopey Bit', '6C', 'Ari Chen', 640, 1, false, 'Nov 2024'],
    ['Heel Yeah', '7A+', 'Lena Park', 241, 3, true, 'Apr 2025'],
    ['Toe Jam', '6B', 'Max Ruiz', 1530, 2, false, 'May 2024'],
    ['Gaston Gamble', '7B+', 'Ben Moon', 96, 2, true, 'Jul 2025'],
    ['Micro Wave', '7C', 'Kai Novak', 41, 3, false, 'Sep 2026'],
    ['Undercling Club', '6A+', 'Sam Ortiz', 2210, 1, false, 'Dec 2023'],
    ['Big Moves Only', '7A', 'Ari Chen', 505, 2, true, 'Oct 2025'],
    ['Sidepull City', '6C+', 'Max Ruiz', 733, 2, false, 'Jan 2026'],
    ['Last Pull', '8A', 'Kai Novak', 12, 3, true, 'Aug 2026'],
  ];
  const problems = raw.map((p, i) => ({
    id: i + 1, name: p[0], grade: p[1], setter: p[2], ascents: p[3], stars: p[4], quality: Math.min(3, p[4] * 0.8 + 0.4 + (i % 3) * 0.1).toFixed(1), benchmark: p[5], set: p[6],
    sent: [1, 3, 4, 8, 11].includes(i + 1), favorite: [1, 5, 7, 12].includes(i + 1), betaCount: i === 9 ? 0 : (i * 5) % 4 + 2,
  }));

  function rng(seed) { let s = seed; return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; }; }
  function holdsFor(id, rows, cols, mirror) {
    const r = rng(id * 97 + 13);
    const pick = (a, b) => a + Math.floor(r() * (b - a + 1));
    const clamp = c => Math.max(0, Math.min(cols - 1, c));
    const out = []; const used = {};
    const add = (row, col, role) => { col = clamp(col); const k = row + '-' + col; if (used[k]) return; used[k] = 1; out.push({ r: row, c: mirror ? cols - 1 - col : col, role }); };
    let c = pick(2, cols - 3);
    add(pick(2, 4), c, 'start');
    if (r() > 0.4) add(pick(2, 5), c + pick(1, 2), 'start');
    let row = 6;
    while (row < rows - 1) { c = clamp(c + pick(-3, 3)); add(row, c, 'hand'); row += pick(2, 4); }
    add(pick(1, 2), pick(1, cols - 2), 'foot');
    if (r() > 0.5) add(1, pick(1, cols - 2), 'foot');
    add(rows, c + pick(-2, 2), 'finish');
    return out;
  }

  const climbers = [
    ['Kai Novak', 2840, '8A', 214], ['Lena Park', 2610, '7C+', 198], ['Jo Ko', 2390, '7C', 176], ['Ben Moon', 2210, '7C', 150],
    ['Ari Chen', 1980, '7B+', 161], ['Max Ruiz', 1720, '7B', 143], ['You', 1645, '7A+', 128], ['Sam Ortiz', 1510, '7A+', 119],
    ['Nora Weiss', 1380, '7A', 102], ['Theo Blanc', 1220, '7A', 97],
  ].map((c, i) => ({ rank: i + 1, name: c[0], points: c[1], top: c[2], sends: c[3], you: c[0] === 'You' }));

  const ascents = [
    ['Lena Park', 'Flashed', '2h ago', 3, 'Heel hook on the second move is the key.'],
    ['Jo Ko', 'Sent in 4', 'Yesterday', 2, 'Feels soft for the grade.'],
    ['Max Ruiz', 'Sent in 11', 'Sep 26', 3, ''],
    ['Nora Weiss', 'Flashed', 'Sep 24', 2, 'Crimpy but fair.'],
  ].map(a => ({ name: a[0], result: a[1], when: a[2], stars: a[3], comment: a[4] }));

  const betas = [
    ['Flash beta, heel hook version', '@lenapark', '0:42', '1.2k views'],
    ['Tall person beta', '@kai.climbs', '0:28', '860 views'],
    ['Static all the way', '@jo_ko', '1:08', '412 views'],
    ['Dyno skip', '@maxruiz', '0:19', '2.3k views'],
    ['Slow-mo crux', '@ari', '0:55', '300 views'],
  ].map(b => ({ title: b[0], author: b[1], duration: b[2], meta: b[3] }));

  const lists = [
    { id: 'fav', name: 'Favorites', icon: 'heart', ids: [1, 5, 7, 12] },
    { id: 'proj', name: 'Project season', icon: 'flame', ids: [9, 10, 14, 5] },
    { id: 'warm', name: 'Warm-ups', icon: 'sun', ids: [3, 11, 8] },
    { id: 'comp', name: 'Comp prep', icon: 'trophy', ids: [4, 2, 13, 6, 12] },
  ];

  const weekly = [4, 6, 3, 8, 7, 5, 9, 6, 10, 8, 12, 9];
  const pyramid = [['6A', 18], ['6A+', 14], ['6B', 16], ['6B+', 12], ['6C', 10], ['6C+', 9], ['7A', 6], ['7A+', 3]];
  const logbook = [
    { date: 'Today', items: [[1, 'Flash'], [4, 'Send · 3 tries']] },
    { date: 'Sat, Sep 26', items: [[8, 'Send · 2 tries'], [2, 'Attempts · 6'], [11, 'Flash']] },
    { date: 'Thu, Sep 24', items: [[3, 'Flash'], [5, 'Attempts · 9']] },
  ];

  const devices = [
    { id: 'MB-7F2A', name: 'Moonboard 2024', type: 'moon', rssi: 'Strong' },
    { id: 'KB-19C0', name: 'Kilter Homewall', type: 'kilter', rssi: 'Good' },
    { id: 'TB-44E1', name: 'Tension Board 2', type: 'tension', rssi: 'Weak' },
  ];

  window.BZ_DATA = { GRADES, V, BOARDS, problems, holdsFor, climbers, ascents, betas, lists, weekly, pyramid, logbook, devices };
})();
