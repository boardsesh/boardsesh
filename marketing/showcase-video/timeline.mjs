// The showcase video as a pure function of the frame number.
//
// `init(data)` builds the DOM once from what the renderer injects (copy,
// footage, anchors, poses). `renderAt(frame)` then only writes CSS custom
// properties, SVG attributes and img.src, and reads nothing but `data` and the
// frame, so any frame can be rendered in any order and always looks the same.

import {
  anchorAt,
  catmullRomPolyline,
  clamp,
  easeIn,
  easeInOut,
  easeOut,
  lengthNearest,
  lerp,
  mixOklab,
  pointAtLength,
  polylinePath,
  progress,
  projectPoint,
  spring,
  springAt,
} from './anim.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per-format placements that are not phone poses. */
const LAYOUT = {
  '16x9': {
    motif: { cx: 1430, cy: 540, maxWidth: 660, maxHeight: 700 },
    grid: { cx: 1430, cy: 540, rx: 600, ry: 560 },
    glow: { hook: [1430, 540, 1.0, 0.55], boards: [960, 690, 1.6, 1], outro: [960, 470, 1.15, 0.6] },
    outro: { mark: 150, wordmark: 338, dots: 566, tagline: 646, pill: 790, dotsHalfWidth: 300, zig: 16 },
    boardLabelGap: 30,
    boardLabelOutward: 0,
    boardLabelLift: 0,
    rowStagger: 12,
  },
  '9x16': {
    motif: { cx: 540, cy: 1200, maxWidth: 760, maxHeight: 900 },
    grid: { cx: 540, cy: 1200, rx: 620, ry: 760 },
    glow: { hook: [540, 1200, 1.2, 0.55], boards: [540, 1260, 1.4, 1], outro: [540, 860, 1.1, 0.6] },
    outro: { mark: 470, wordmark: 668, dots: 862, tagline: 940, pill: 1086, dotsHalfWidth: 260, zig: 16 },
    boardLabelGap: 26,
    boardLabelOutward: 70,
    boardLabelLift: 30,
    rowStagger: 12,
  },
};

const SCENE_POSE = {
  hook: 'OFF_RIGHT',
  light: 'CALLOUT',
  boards: 'BOARDS_MID',
  crew: 'CALLOUT',
  log: 'HERO_TILT',
  outro: 'OFF_RIGHT',
};

let data = null;
let layout = null;
const ui = {};
let visible = [];

// --- DOM helpers (init only) ------------------------------------------------

function el(tag, attributes = {}, parent = null) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  if (parent) parent.appendChild(node);
  return node;
}

function svg(tag, attributes = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'text') node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  if (parent) parent.appendChild(node);
  return node;
}

const setVars = (node, vars) => {
  for (const [key, value] of Object.entries(vars)) {
    node.style.setProperty(`--${key}`, typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value);
  }
};

const setAttrs = (node, attributes) => {
  for (const [key, value] of Object.entries(attributes)) {
    node.setAttribute(key, typeof value === 'number' ? String(Math.round(value * 100) / 100) : value);
  }
};

/** `"Your board.\nLit from your *phone.*"` → lines of { text, accent }. Mirrors render.ts parseHeadline. */
function parseHeadline(headline) {
  return headline
    .split('\n')
    .map((line) =>
      [...line.matchAll(/\*([^*]+)\*|(\S+)/g)].map((match) =>
        match[1] ? { text: match[1], accent: true } : { text: match[2], accent: false },
      ),
    );
}

function buildWords(container, headline) {
  const words = [];
  let regular = 0;
  for (const line of parseHeadline(headline)) {
    const lineNode = el('span', { class: 'line' }, container);
    line.forEach((word, index) => {
      if (index > 0) lineNode.appendChild(document.createTextNode(' '));
      const node = el('span', { class: word.accent ? 'w accent' : 'w', text: word.text }, lineNode);
      words.push({ node, accent: word.accent, regularIndex: word.accent ? -1 : regular });
      if (!word.accent) regular += 1;
    });
    container.appendChild(document.createTextNode(' '));
  }
  return { words, regularCount: regular };
}

function buildPhone(rig) {
  const body = el('div', { class: 'phone-body' }, rig);
  const bezel = el('div', { class: 'bezel' }, body);
  const screen = el('div', { class: 'screen' }, bezel);
  const img = el('img', { alt: '', decoding: 'sync' }, screen);
  el('div', { class: 'gloss' }, screen);
  el('div', { class: 'island' }, screen);
  // Action button, volume up/down on the left; side button and Camera Control on the right.
  for (const [side, top, height] of [
    ['left', 188, 58],
    ['left', 268, 92],
    ['left', 376, 92],
    ['right', 300, 136],
    ['right', 588, 84],
  ]) {
    const button = el('i', { class: `phone-btn ${side}` }, rig);
    button.style.top = `${top}px`;
    button.style.height = `${height}px`;
  }
  return { rig, img };
}

// --- geometry -------------------------------------------------------------------

const projection = () => ({ perspective: data.perspective, originX: data.width / 2, originY: data.height / 2 });

const screenToPhone = (point, screen) => ({
  x: -data.phone.screenWidth / 2 + (point.x * data.phone.screenWidth) / screen.width,
  y: -data.phone.screenHeight / 2 + (point.y * data.phone.screenHeight) / screen.height,
});

function projectRect(rect, screen, pose) {
  const corners = [
    [rect.x, rect.y],
    [rect.x + rect.width, rect.y],
    [rect.x, rect.y + rect.height],
    [rect.x + rect.width, rect.y + rect.height],
  ].map(([x, y]) => {
    const local = screenToPhone({ x, y }, screen);
    return projectPoint(pose, local.x, local.y, projection());
  });
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

const lerpPose = (from, to, amount) => ({
  cx: lerp(from.cx, to.cx, amount),
  cy: lerp(from.cy, to.cy, amount),
  scale: lerp(from.scale, to.scale, amount),
  rx: lerp(from.rx, to.rx, amount),
  ry: lerp(from.ry, to.ry, amount),
  rz: lerp(from.rz, to.rz, amount),
});

/** Keyframes are { frame, pose }: each move springs from the previous target, released at `frame`. */
function poseAt(keys, frame) {
  let index = 0;
  for (let candidate = 0; candidate < keys.length; candidate += 1)
    if (keys[candidate].frame <= frame) index = candidate;
  if (index === 0) return keys[0].pose;
  const amount = springAt(frame, keys[index].frame, data.fps);
  return lerpPose(keys[index - 1].pose, keys[index].pose, amount);
}

/** Orthogonal path through `points` with rounded bends of radius `radius`. */
function orthoPath(points, radius = 10) {
  const clean = points.filter(
    (point, index) => index === 0 || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > 0.5,
  );
  if (clean.length < 2) return `M${clean[0].x} ${clean[0].y}`;
  let path = `M${clean[0].x.toFixed(2)} ${clean[0].y.toFixed(2)}`;
  for (let index = 1; index < clean.length - 1; index += 1) {
    const previous = clean[index - 1];
    const corner = clean[index];
    const next = clean[index + 1];
    const into = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const out = Math.hypot(next.x - corner.x, next.y - corner.y);
    const bend = Math.min(radius, into / 2, out / 2);
    const before = {
      x: corner.x - ((corner.x - previous.x) / into) * bend,
      y: corner.y - ((corner.y - previous.y) / into) * bend,
    };
    const after = {
      x: corner.x + ((next.x - corner.x) / out) * bend,
      y: corner.y + ((next.y - corner.y) / out) * bend,
    };
    path += ` L${before.x.toFixed(2)} ${before.y.toFixed(2)} Q${corner.x.toFixed(2)} ${corner.y.toFixed(2)} ${after.x.toFixed(2)} ${after.y.toFixed(2)}`;
  }
  const last = clean[clean.length - 1];
  return `${path} L${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
}

// --- scene lookup ------------------------------------------------------------------

const sceneIndexAt = (frame) => {
  for (let index = 0; index < data.scenes.length; index += 1) {
    if (frame < data.scenes[index].endFrame) return index;
  }
  return data.scenes.length - 1;
};
const sceneById = (id) => data.scenes.find((scene) => scene.id === id);
const sceneLength = (scene) => scene.endFrame - scene.startFrame;

/** Light-background amount at `frame`, tweened (OKLab, via mixOklab) across L-4..L+6 at each change. */
function lightMixAt(frame) {
  const { backgroundLeadIn, backgroundLeadOut } = data.choreo;
  let mix = data.scenes[0].background === 'light' ? 1 : 0;
  for (let index = 1; index < data.scenes.length; index += 1) {
    const boundary = data.scenes[index].startFrame;
    const target = data.scenes[index].background === 'light' ? 1 : 0;
    if (frame < boundary - backgroundLeadIn) break;
    mix = lerp(
      mix,
      target,
      easeInOut(progress(frame, boundary - backgroundLeadIn, backgroundLeadIn + backgroundLeadOut)),
    );
  }
  return mix;
}

// --- word choreography ---------------------------------------------------------------

function wordIn(local, word, regularCount, timing = {}) {
  const { firstWord, wordStagger, wordFrames, accentDelay, accentFrames } = { ...data.choreo, ...timing };
  if (word.accent) {
    const start = firstWord + wordStagger * Math.max(0, regularCount - 1) + accentDelay;
    return { amount: easeOut(progress(local, start, accentFrames)), blur: 22 };
  }
  return { amount: easeOut(progress(local, firstWord + wordStagger * word.regularIndex, wordFrames)), blur: 14 };
}

function applyWords(group, local, outAmount, timing) {
  for (const word of group.words) {
    const { amount, blur } =
      local === Infinity ? { amount: 1, blur: 0 } : wordIn(local, word, group.regularCount, timing);
    setVars(word.node, {
      o: amount * (1 - outAmount),
      b: blur * (1 - amount) + 14 * outAmount,
      y: 20 * (1 - amount) - 10 * outAmount,
    });
  }
}

const wordsOut = (scene, local) => {
  const length = sceneLength(scene);
  return easeIn(
    progress(local, length - data.choreo.wordsOutFromEnd, data.choreo.wordsOutFromEnd - data.choreo.wordsOutEndFromEnd),
  );
};

// --- init ----------------------------------------------------------------------------------

export function init(input) {
  data = input;
  layout = LAYOUT[data.format];
  const stage = document.getElementById('stage');
  stage.dataset.format = data.format;
  ui.stage = stage;
  ui.text = document.getElementById('text');
  ui.callouts = document.getElementById('callouts');
  ui.pills = document.getElementById('pills');
  ui.measure = document.getElementById('measure');
  ui.glows = [...stage.querySelectorAll('.glow')];

  for (const layer of stage.querySelectorAll('svg.layer')) {
    layer.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
  }

  // Phones.
  ui.phones = {
    main: buildPhone(document.getElementById('phoneMain')),
    left: buildPhone(document.getElementById('phoneLeft')),
    right: buildPhone(document.getElementById('phoneRight')),
  };
  ui.shadows = {
    main: document.getElementById('shadowMain'),
    left: document.getElementById('shadowLeft'),
    right: document.getElementById('shadowRight'),
  };

  const poses = data.poses;
  const below = (pose) => ({ ...pose, cy: pose.cy + data.height * 0.85 });
  const release = (scene) => scene.startFrame - data.choreo.backgroundLeadIn;
  ui.mainKeys = [{ frame: -Infinity, pose: poses[SCENE_POSE[data.scenes[0].id]] }];
  for (const scene of data.scenes.slice(1))
    ui.mainKeys.push({ frame: release(scene), pose: poses[SCENE_POSE[scene.id]] });
  const boards = sceneById('boards');
  ui.leftKeys = [
    { frame: -Infinity, pose: below(poses.BOARDS_LEFT) },
    { frame: boards.startFrame - 2, pose: poses.BOARDS_LEFT },
    { frame: boards.endFrame - 6, pose: below(poses.BOARDS_LEFT) },
  ];
  ui.rightKeys = [
    { frame: -Infinity, pose: below(poses.BOARDS_RIGHT) },
    { frame: boards.startFrame + 3, pose: poses.BOARDS_RIGHT },
    { frame: boards.endFrame - 4, pose: below(poses.BOARDS_RIGHT) },
  ];
  // The glow follows the phone, or the motif / outro mark when there is no phone.
  const glowFor = (scene) => {
    const custom = layout.glow[scene.id];
    if (custom) return { cx: custom[0], cy: custom[1], scale: custom[2], rx: custom[3], ry: 0, rz: 0 };
    const pose = poses[SCENE_POSE[scene.id]];
    return { cx: pose.cx, cy: pose.cy, scale: pose.scale, rx: 1, ry: 0, rz: 0 };
  };
  ui.glowKeys = [{ frame: -Infinity, pose: glowFor(data.scenes[0]) }];
  for (const scene of data.scenes.slice(1)) ui.glowKeys.push({ frame: release(scene), pose: glowFor(scene) });
  // The loop closer hands the glow back to the hook's motif, so the last frame matches frame 0.
  const lastScene = data.scenes[data.scenes.length - 1];
  ui.glowKeys.push({ frame: lastScene.endFrame - data.choreo.loopCloserFrames, pose: glowFor(data.scenes[0]) });

  // Headlines.
  ui.headlines = {};
  for (const scene of data.scenes) {
    const copy = data.copy[scene.id];
    if (!copy || !copy.headline) continue;
    const container = el(
      'div',
      { class: `headline ${scene.background === 'light' ? 'on-light' : 'on-dark'}`, 'data-scene': scene.id },
      ui.text,
    );
    ui.headlines[scene.id] = { container, ...buildWords(container, copy.headline) };
  }

  // Board labels.
  ui.boardLabels = data.copy.boards.labels.map((label) => el('div', { class: 'board-label', text: label }, ui.text));

  // Callouts.
  ui.sceneCallouts = {};
  for (const scene of data.scenes) {
    ui.sceneCallouts[scene.id] = scene.callouts.map((callout) => {
      const group = svg('g', { class: 'callout', 'data-role': callout.role }, ui.callouts);
      const box = svg('rect', { class: 'callout-box', rx: 14, pathLength: 1 }, group);
      const leader = svg('path', { class: 'callout-leader', pathLength: 1 }, group);
      const dot = svg('circle', { r: 3 }, group);
      const pill = el(
        'div',
        {
          class: 'pill callout',
          'data-role': callout.role,
          'data-side': callout.side,
          'data-portrait': String(data.format === '9x16'),
        },
        ui.pills,
      );
      el('span', { class: 'dot' }, pill);
      el('span', { text: callout.label }, pill);
      return { callout, group, box, leader, dot, pill };
    });
  }

  // Log checklist.
  const checklist = el('div', { class: 'checklist' }, ui.text);
  ui.checklist = checklist;
  ui.rows = data.copy.log.rows.map((row) => {
    const node = el('div', { class: 'row' }, checklist);
    const check = el('div', { class: 'check' }, node);
    const checkSvg = svg('svg', { viewBox: '0 0 36 36', width: 36, height: 36 }, check);
    svg('circle', { class: 'ring', cx: 18, cy: 18, r: 16.75 }, checkSvg);
    const fill = svg('circle', { class: 'fill', cx: 18, cy: 18, r: 0 }, checkSvg);
    const tick = svg('path', { class: 'tick', d: 'M10.5 18.5 L15.8 23.5 L25.5 12.8', pathLength: 1 }, checkSvg);
    el('span', { class: 'name', text: row.name }, node);
    const chip = el('span', { class: 'chip', text: row.grade }, node);
    const grade = data.grades[row.grade.replace(/\+$/, '')] ?? { background: '#808080', ink: '#000000' };
    setVars(chip, { 'chip-bg': grade.background, 'chip-ink': grade.ink });
    el('span', { class: 'time', text: row.time }, node);
    return { node, fill, tick };
  });
  const track = el('div', { class: 'progress' }, checklist);
  ui.progressTrack = track;
  ui.progressFill = el('div', { class: 'fill' }, track);

  // Motif: holds in screen points → hook positions on the canvas.
  const lightTake = data.takes.light;
  const screen = lightTake ? lightTake.screen : { width: 440, height: 956 };
  const xs = data.holds.map((hold) => hold.x);
  const ys = data.holds.map((hold) => hold.y);
  const spanX = Math.max(...xs) - Math.min(...xs) || 1;
  const spanY = Math.max(...ys) - Math.min(...ys) || 1;
  const motifScale = Math.min(layout.motif.maxWidth / spanX, layout.motif.maxHeight / spanY);
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midY = (Math.max(...ys) + Math.min(...ys)) / 2;
  ui.holds = data.holds.map((hold) => ({
    role: hold.role,
    hook: { x: layout.motif.cx + (hold.x - midX) * motifScale, y: layout.motif.cy + (hold.y - midY) * motifScale },
    local: screenToPhone(hold, screen),
  }));
  ui.hookCurve = catmullRomPolyline(ui.holds.map((hold) => hold.hook));
  ui.holds.forEach((hold) => {
    hold.along = lengthNearest(ui.hookCurve, hold.hook);
  });
  const lineGradient = document.getElementById('lineGradient');
  const first = ui.holds[0]?.hook ?? { x: 0, y: 0 };
  const last = ui.holds[ui.holds.length - 1]?.hook ?? { x: 1, y: 1 };
  setAttrs(lineGradient, { x1: first.x, y1: first.y, x2: last.x, y2: last.y });
  setAttrs(document.getElementById('gridMaskShape'), {
    cx: layout.grid.cx,
    cy: layout.grid.cy,
    rx: layout.grid.rx,
    ry: layout.grid.ry,
  });
  const rings = document.getElementById('rings');
  ui.rings = ui.holds.map((hold) => {
    const color = `var(--role-${hold.role})`;
    const group = svg('g', { class: 'ring' }, rings);
    const halo = svg('circle', { r: 24, fill: color, filter: 'url(#softGlow)', class: 'ring-halo' }, group);
    halo.style.fill = color;
    const ring = svg('circle', { r: 13, 'stroke-width': 4, 'fill-opacity': 0.22 }, group);
    ring.style.fill = color;
    ring.style.stroke = color;
    return { group, halo };
  });
  ui.motifBack = document.getElementById('motifBack');
  ui.motifLine = document.getElementById('motifLine');
  ui.grid = document.getElementById('grid');
  ui.spark = document.getElementById('spark');
  ui.sparkTrail = document.getElementById('sparkTrail');

  // Outro.
  const outro = el('div', { class: 'outro' }, ui.text);
  ui.outro = outro;
  const place = (node, top) => {
    node.classList.add('outro-el');
    setVars(node, { top });
    return node;
  };
  ui.outroMark = place(el('img', { class: 'mark', src: data.markUrl, alt: '' }, outro), layout.outro.mark);
  ui.outroWordmark = place(
    el('div', { class: 'wordmark', text: data.copy.outro.wordmark }, outro),
    layout.outro.wordmark,
  );
  const tagline = place(el('div', { class: 'tagline on-dark' }, outro), layout.outro.tagline);
  ui.outroTagline = { container: tagline, ...buildWords(tagline, data.copy.outro.tagline) };
  ui.outroPill = place(el('div', { class: 'store-pill', text: data.copy.outro.pill }, outro), layout.outro.pill);
  const dotsSvg = svg('svg', { class: 'layer', id: 'outroDots', viewBox: `0 0 ${data.width} ${data.height}` }, outro);
  const defs = svg('defs', {}, dotsSvg);
  const outroGradient = svg('linearGradient', { id: 'lineGradientOutro', gradientUnits: 'userSpaceOnUse' }, defs);
  svg('stop', { offset: 0, 'stop-color': '#6D28D9' }, outroGradient);
  svg('stop', { offset: 1, 'stop-color': '#C4B5FD' }, outroGradient);
  const dotRoles = ['start', 'hand', 'hand', 'hand', 'finish'];
  ui.outroDotPoints = dotRoles.map((_, index) => ({
    x: data.width / 2 + (index - 2) * (layout.outro.dotsHalfWidth / 2),
    y: layout.outro.dots + (index % 2 === 0 ? layout.outro.zig : -layout.outro.zig),
  }));
  setAttrs(outroGradient, {
    x1: ui.outroDotPoints[0].x,
    y1: 0,
    x2: ui.outroDotPoints[4].x,
    y2: 0,
  });
  ui.outroZig = svg('path', { class: 'zig', d: polylinePath(ui.outroDotPoints), pathLength: 1 }, dotsSvg);
  ui.outroCurve = catmullRomPolyline(ui.outroDotPoints, 1);
  ui.outroDots = dotRoles.map((role, index) => {
    const color = `var(--role-${role})`;
    const group = svg('g', {}, dotsSvg);
    const halo = svg('circle', { r: 18, filter: 'url(#softGlow)', opacity: 0.6 }, group);
    halo.style.fill = color;
    const dot = svg('circle', { r: 9 }, group);
    dot.style.fill = color;
    return { group, role, fraction: index / (dotRoles.length - 1) };
  });
  // Which outro dot each hook hold grows out of in the loop closer.
  const handHolds = ui.holds.filter((hold) => hold.role === 'hand');
  ui.holds.forEach((hold) => {
    if (hold.role === 'start') hold.dot = 0;
    else if (hold.role === 'finish') hold.dot = 4;
    else {
      const order = handHolds.indexOf(hold);
      hold.dot = 1 + Math.min(2, Math.floor((order * 3) / Math.max(1, handHolds.length)));
    }
  });

  // Measure overlay.
  ui.measureItems = [];
  if (data.measure) {
    for (const [takeId, take] of Object.entries(data.takes)) {
      for (const [name, samples] of Object.entries(take.anchors)) {
        const rect = svg('rect', { visibility: 'hidden' }, ui.measure);
        const label = svg('text', { visibility: 'hidden', text: name }, ui.measure);
        ui.measureItems.push({ takeId, samples, rect, label });
      }
    }
    ui.measureCrosses = ui.holds.map(() => svg('path', { class: 'cross', visibility: 'hidden' }, ui.measure));
  }
  return true;
}

// --- per-frame -----------------------------------------------------------------------------------

function mainTake(sceneIndex) {
  const pick = (scene) => (scene.id === 'boards' ? scene.takes[1] : scene.takes[0]);
  const scene = data.scenes[sceneIndex];
  if (scene.takes.length) return { takeId: pick(scene), scene };
  const previous = data.scenes[sceneIndex - 1];
  if (previous && previous.takes.length) return { takeId: pick(previous), scene: previous };
  const next = data.scenes[sceneIndex + 1];
  if (next && next.takes.length) return { takeId: pick(next), scene: next };
  return null;
}

function footageIndex(take, scene, frame) {
  return clamp(frame - scene.startFrame + data.leadFrames, 0, take.frameCount - 1);
}

const frameUrl = (take, index) => `${take.frameUrlBase}${String(index + 1).padStart(5, '0')}.jpg`;

function onCanvas(pose) {
  const margin = 480 * pose.scale;
  return pose.cx > -margin && pose.cx < data.width + margin && pose.cy > -margin && pose.cy < data.height + margin;
}

function applyPhone(key, pose, takeRef, frame, footageOpacity) {
  const { rig, img } = ui.phones[key];
  setVars(rig, {
    cx: pose.cx,
    cy: pose.cy,
    s: pose.scale,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    'footage-o': footageOpacity,
  });
  setVars(ui.shadows[key], { cx: pose.cx, cy: pose.cy + 452 * pose.scale, s: pose.scale });
  if (!takeRef || !onCanvas(pose)) return;
  const take = data.takes[takeRef.takeId];
  if (!take) return;
  const src = frameUrl(take, footageIndex(take, takeRef.scene, frame));
  if (img.getAttribute('src') !== src) img.src = src;
  if (footageOpacity > 0) visible.push(img);
}

function renderHeadlines(frame, sceneIndex) {
  const hookScene = data.scenes[0];
  const outroScene = sceneById('outro');
  for (const [sceneId, group] of Object.entries(ui.headlines)) {
    const scene = sceneById(sceneId);
    const local = frame - scene.startFrame;
    let on = frame >= scene.startFrame && frame < scene.endFrame;
    if (sceneId === hookScene.id) {
      // The hook is settled on frame 0 (the poster) and blurs back in during the loop closer.
      const closerStart = outroScene.endFrame - 17;
      if (frame >= closerStart) {
        on = true;
        applyWords(group, frame - closerStart, 0, {
          firstWord: 0,
          wordStagger: 1,
          wordFrames: 10,
          accentDelay: 1,
          accentFrames: 12,
        });
      } else if (on) {
        applyWords(group, Infinity, wordsOut(scene, local));
      }
    } else if (on) {
      applyWords(group, local, wordsOut(scene, local));
    }
    setVars(group.container, { on: on ? 1 : 0 });
  }
  return sceneIndex;
}

function renderCallouts(frame, sceneIndex, mainPose) {
  const choreo = data.choreo;
  for (const [sceneId, items] of Object.entries(ui.sceneCallouts)) {
    const scene = sceneById(sceneId);
    const active = data.scenes[sceneIndex].id === sceneId;
    if (!active || items.length === 0) {
      for (const item of items) {
        setAttrs(item.group, { visibility: 'hidden' });
        setVars(item.pill, { o: 0 });
      }
      continue;
    }
    const local = frame - scene.startFrame;
    const length = sceneLength(scene);
    const take = data.takes[scene.takes[0]];
    const time = footageIndex(take, scene, frame) / data.fps;
    const retract = easeInOut(
      progress(local, length - choreo.calloutsOutFromEnd, choreo.calloutsOutFromEnd - choreo.calloutsOutEndFromEnd),
    );
    items.forEach((item, index) => {
      const rect = anchorAt(take.anchors[item.callout.name], time);
      if (!rect) {
        setAttrs(item.group, { visibility: 'hidden' });
        setVars(item.pill, { o: 0 });
        return;
      }
      const start = choreo.calloutStart + choreo.calloutStagger * index;
      const boxAmount = easeOut(progress(local, start, choreo.boxFrames)) * (1 - retract);
      const leaderAmount = easeInOut(progress(local, start + choreo.leaderDelay, choreo.leaderFrames)) * (1 - retract);
      const pillStart = start + choreo.pillDelay;
      const pillOpacity = easeOut(progress(local, pillStart, 6)) * (1 - retract);
      const pillScale =
        local < pillStart
          ? 0.9
          : 0.9 + 0.1 * spring((local - pillStart) / data.fps, { zeta: 0.55, period: 0.42 }) - 0.05 * retract;
      const projected = projectRect(rect, take.screen, mainPose);
      const pad = data.layout.boxPadding;
      const box = {
        x: projected.x - pad,
        y: projected.y - pad,
        width: projected.width + pad * 2,
        height: projected.height + pad * 2,
      };
      const centreY = box.y + box.height / 2;
      let points;
      let pillX;
      if (data.format === '16x9') {
        pillX = data.layout.pillX;
        points = [
          { x: box.x + box.width, y: centreY },
          { x: item.callout.gutterX, y: centreY },
          { x: item.callout.gutterX, y: item.callout.slotY },
          { x: pillX, y: item.callout.slotY },
        ];
      } else {
        const inset = data.layout.portraitPillInset;
        const width = data.layout.portraitPillWidth;
        const leftSide = item.callout.side === 'left';
        const pillEdge = leftSide ? inset + width : data.width - inset - width;
        const startX = leftSide ? box.x : box.x + box.width;
        const middle = (startX + pillEdge) / 2;
        pillX = leftSide ? inset : pillEdge;
        points = [
          { x: startX, y: centreY },
          { x: middle, y: centreY },
          { x: middle, y: item.callout.slotY },
          { x: pillEdge, y: item.callout.slotY },
        ];
      }
      setAttrs(item.group, { visibility: 'visible' });
      setAttrs(item.box, {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        'stroke-dasharray': `${boxAmount.toFixed(4)} 1`,
        'fill-opacity': 0.1 * boxAmount,
      });
      // A zero-length dash still paints its round cap, so an undrawn path is hidden outright.
      setAttrs(item.leader, {
        d: orthoPath(points),
        'stroke-dasharray': `${leaderAmount.toFixed(4)} 1`,
        opacity: leaderAmount > 0.001 ? 1 : 0,
      });
      setAttrs(item.dot, { cx: points[0].x, cy: points[0].y, opacity: Math.min(1, leaderAmount * 4) });
      setVars(item.pill, { px: pillX, py: item.callout.slotY, o: pillOpacity, k: pillScale });
    });
  }
}

function renderBoards(frame, leftPose, midPose, rightPose) {
  const scene = sceneById('boards');
  const local = frame - scene.startFrame;
  const on = frame >= scene.startFrame - 2 && frame < scene.endFrame + 4;
  const out = wordsOut(scene, local);
  [leftPose, midPose, rightPose].forEach((pose, index) => {
    const label = ui.boardLabels[index];
    if (!on) {
      setVars(label, { o: 0 });
      return;
    }
    const amount = easeOut(progress(local, 16 + 4 * index, 14));
    // 9:16 fans the phones, so the side labels step outward, clear of the middle phone.
    const outward = (index - 1) * layout.boardLabelOutward;
    setVars(label, {
      lx: pose.cx + outward,
      ly:
        pose.cy -
        (data.phone.height / 2) * pose.scale -
        layout.boardLabelGap -
        30 -
        (index === 1 ? 0 : layout.boardLabelLift),
      o: amount * (1 - out),
      b: 10 * (1 - amount) + 10 * out,
      y: 14 * (1 - amount),
    });
  });
}

function renderChecklist(frame) {
  const scene = sceneById('log');
  const local = frame - scene.startFrame;
  const on = frame >= scene.startFrame && frame < scene.endFrame;
  setVars(ui.checklist, { on: on ? 1 : 0 });
  if (!on) return;
  const out = wordsOut(scene, local);
  let ticked = 0;
  ui.rows.forEach((row, index) => {
    const enter = 24 + layout.rowStagger * index;
    const amount = easeOut(progress(local, enter, 12));
    const fill = easeOut(progress(local, enter + 10, 8));
    const tick = easeInOut(progress(local, enter + 13, 8));
    ticked += fill;
    setVars(row.node, { o: amount * (1 - out), b: 10 * (1 - amount) + 12 * out, x: -24 * (1 - amount) });
    setAttrs(row.fill, { r: 18 * fill });
    setAttrs(row.tick, { 'stroke-dasharray': `${tick.toFixed(4)} 1`, opacity: tick > 0.001 ? 1 : 0 });
  });
  setVars(ui.progressTrack, { 'track-o': easeOut(progress(local, 24, 12)) * (1 - out) });
  setVars(ui.progressFill, { p: ticked / ui.rows.length });
}

function renderOutro(frame) {
  const scene = sceneById('outro');
  const local = frame - scene.startFrame;
  const length = sceneLength(scene);
  const on = frame >= scene.startFrame;
  setVars(ui.outro, { on: on ? 1 : 0 });
  if (!on) return { sparkAmount: 0 };
  const closer = length - data.choreo.loopCloserFrames;
  const out = easeIn(progress(local, closer - 1, 10));
  const reveal = (node, start, frames, blurFrom = 14, rise = 20) => {
    const amount = easeOut(progress(local, start, frames));
    setVars(node, { o: amount * (1 - out), b: blurFrom * (1 - amount) + 14 * out, y: rise * (1 - amount) - 10 * out });
    return amount;
  };
  reveal(ui.outroMark, 3, 16, 12, 0);
  setVars(ui.outroMark, { k: local < 3 ? 0.86 : 0.86 + 0.14 * spring((local - 3) / data.fps) });
  reveal(ui.outroWordmark, 8, 16);
  applyWords(ui.outroTagline, local, out, { firstWord: 34 });
  setVars(ui.outroTagline.container, { o: 1 });
  reveal(ui.outroPill, 50, 16, 12, 16);

  // The spark draws the dots line left to right.
  const sparkAmount = easeInOut(progress(local, 16, 24));
  const dotsFade = 1 - easeOut(progress(local, closer, 6));
  setAttrs(ui.outroZig, {
    'stroke-dasharray': `${sparkAmount.toFixed(4)} 1`,
    opacity: sparkAmount > 0.001 ? dotsFade : 0,
  });
  ui.outroDots.forEach((dot, index) => {
    const reached = local >= 16 && sparkAmount + 1e-6 >= dot.fraction;
    const pop = reached ? clamp((sparkAmount - dot.fraction) / 0.1 + 0.25) : 0;
    const scale = pop <= 0 ? 0 : 1 + 0.35 * Math.sin(Math.PI * clamp(pop)) * (1 - clamp(pop));
    const point = ui.outroDotPoints[index];
    setAttrs(dot.group, {
      transform: `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) scale(${(scale * Math.min(1, pop * 2)).toFixed(3)})`,
      opacity: dotsFade,
    });
  });
  const sparkPoint = pointAtLength(ui.outroCurve, sparkAmount * ui.outroCurve.total);
  const sparkOpacity = progress(local, 13, 4) * (1 - progress(local, 40, 6));
  return { sparkAmount, sparkPoint, sparkOpacity, curve: ui.outroCurve };
}

function renderMotif(frame, mainPose, outroState) {
  const outroScene = sceneById('outro');
  const lightScene = sceneById('light');
  const closerStart = outroScene.endFrame - data.choreo.loopCloserFrames;
  const arrive = lightScene.startFrame - data.choreo.backgroundLeadIn;
  const inHook = frame < lightScene.startFrame + 40;
  const inCloser = frame >= closerStart;

  let positions = ui.holds.map((hold) => hold.hook);
  let ringsOpacity = 0;
  let ringScale = 1;
  let lineOpacity = 0;
  let gridOpacity = 0;
  let sparkLength = -1;

  if (inHook) {
    const match = easeInOut(progress(frame, arrive, 18));
    positions = ui.holds.map((hold) => {
      const target = projectPoint(mainPose, hold.local.x, hold.local.y, projection());
      return { x: lerp(hold.hook.x, target.x, match), y: lerp(hold.hook.y, target.y, match) };
    });
    ringScale = lerp(1, mainPose.scale * 0.92, match);
    ringsOpacity = 1 - easeIn(progress(frame, arrive + 26, 14));
    lineOpacity = 1 - easeOut(progress(frame, arrive, 10));
    gridOpacity = 1 - easeIn(progress(frame, arrive - 2, 12));
    sparkLength = easeInOut(progress(frame, 12, 36)) * ui.hookCurve.total;
  } else if (inCloser) {
    const grow = easeInOut(progress(frame, closerStart, data.choreo.loopCloserFrames - 1));
    positions = ui.holds.map((hold) => {
      const from = ui.outroDotPoints[hold.dot];
      return { x: lerp(from.x, hold.hook.x, grow), y: lerp(from.y, hold.hook.y, grow) };
    });
    ringsOpacity = easeOut(progress(frame, closerStart, 6));
    ringScale = lerp(0.7, 1, grow);
    gridOpacity = easeInOut(progress(frame, closerStart + 7, 16));
    lineOpacity = easeInOut(progress(frame, closerStart + 9, 14));
  }

  setVars(ui.motifBack, {
    'motif-o': ringsOpacity > 0 || gridOpacity > 0 ? 1 : 0,
    'grid-o': gridOpacity,
    'line-o': lineOpacity,
  });
  const curve = catmullRomPolyline(positions);
  setAttrs(ui.motifLine, { d: polylinePath(curve.points) });

  const sparkOn = inHook && frame >= 10 && frame < 56;
  const sparkOpacity = inHook ? progress(frame, 10, 4) * (1 - progress(frame, 48, 6)) : 0;
  ui.holds.forEach((hold, index) => {
    const passing = sparkOn ? Math.max(0, 1 - Math.abs(sparkLength - hold.along) / 90) : 0;
    const bright = passing * sparkOpacity;
    const point = positions[index];
    setAttrs(ui.rings[index].group, {
      transform: `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)}) scale(${(ringScale * (1 + 0.32 * bright)).toFixed(3)})`,
      opacity: ringsOpacity,
    });
    setAttrs(ui.rings[index].halo, { opacity: 0.45 + 0.55 * bright });
  });

  // One amber spark: the hook's run up the climb, or the outro's pass along the dots.
  if (sparkOn && sparkOpacity > 0) {
    const point = pointAtLength(ui.hookCurve, sparkLength);
    setAttrs(ui.spark, { transform: `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`, opacity: sparkOpacity });
    const trail = Math.min(sparkLength, 150);
    setAttrs(ui.sparkTrail, {
      d: polylinePath(ui.hookCurve.points),
      'stroke-dasharray': `0 ${((sparkLength - trail) / ui.hookCurve.total).toFixed(4)} ${(trail / ui.hookCurve.total).toFixed(4)} 1`,
      opacity: 0.55 * sparkOpacity,
    });
  } else if (outroState && outroState.sparkOpacity > 0) {
    const point = outroState.sparkPoint;
    setAttrs(ui.spark, {
      transform: `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`,
      opacity: outroState.sparkOpacity,
    });
    setAttrs(ui.sparkTrail, { opacity: 0 });
  } else {
    setAttrs(ui.spark, { opacity: 0 });
    setAttrs(ui.sparkTrail, { opacity: 0 });
  }
}

function renderMeasure(frame, sceneIndex, poses) {
  if (!data.measure) return;
  const main = mainTake(sceneIndex);
  const boards = sceneById('boards');
  const shown = new Map();
  if (main) shown.set(main.takeId, { pose: poses.main, scene: main.scene });
  if (frame >= boards.startFrame && frame < boards.endFrame) {
    shown.set(boards.takes[0], { pose: poses.left, scene: boards });
    shown.set(boards.takes[2], { pose: poses.right, scene: boards });
  }
  for (const item of ui.measureItems) {
    const target = shown.get(item.takeId);
    const take = data.takes[item.takeId];
    const rect = target ? anchorAt(item.samples, footageIndex(take, target.scene, frame) / data.fps) : null;
    if (!target || !rect) {
      setAttrs(item.rect, { visibility: 'hidden' });
      setAttrs(item.label, { visibility: 'hidden' });
      continue;
    }
    const box = projectRect(rect, take.screen, target.pose);
    setAttrs(item.rect, { visibility: 'visible', x: box.x, y: box.y, width: box.width, height: box.height });
    setAttrs(item.label, { visibility: 'visible', x: box.x, y: box.y - 6 });
  }
  const lightOn = main && main.takeId === 'light';
  ui.holds.forEach((hold, index) => {
    const point = projectPoint(poses.main, hold.local.x, hold.local.y, projection());
    setAttrs(ui.measureCrosses[index], {
      visibility: lightOn ? 'visible' : 'hidden',
      d: `M${point.x - 12} ${point.y} H${point.x + 12} M${point.x} ${point.y - 12} V${point.y + 12}`,
    });
  });
}

export function renderAt(frame) {
  if (!data) throw new Error('showcaseInit(data) must run before renderAt');
  visible = [];
  const sceneIndex = sceneIndexAt(frame);
  const lightMix = lightMixAt(frame);
  setVars(ui.stage, {
    'light-mix': lightMix,
    bg: mixOklab(data.palette.stageDark, data.palette.stageLight, lightMix),
  });

  const mainPose = poseAt(ui.mainKeys, frame);
  const leftPose = poseAt(ui.leftKeys, frame);
  const rightPose = poseAt(ui.rightKeys, frame);
  const lightScene = sceneById('light');
  const footageOpacity = frame < lightScene.endFrame ? easeOut(progress(frame, lightScene.startFrame + 8, 14)) : 1;
  applyPhone('main', mainPose, mainTake(sceneIndex), frame, footageOpacity);
  const boards = sceneById('boards');
  applyPhone('left', leftPose, { takeId: boards.takes[0], scene: boards }, frame, 1);
  applyPhone('right', rightPose, { takeId: boards.takes[2], scene: boards }, frame, 1);

  const glow = poseAt(ui.glowKeys, frame);
  for (const node of ui.glows) setVars(node, { gx: glow.cx, gy: glow.cy, gs: glow.scale, gstrength: glow.rx });

  renderHeadlines(frame, sceneIndex);
  renderCallouts(frame, sceneIndex, mainPose);
  renderBoards(frame, leftPose, mainPose, rightPose);
  renderChecklist(frame);
  const outroState = renderOutro(frame);
  renderMotif(frame, mainPose, outroState);
  renderMeasure(frame, sceneIndex, { main: mainPose, left: leftPose, right: rightPose });
  return frame;
}

/** The footage images the current frame shows, so the renderer can await their decode. */
export function visibleImages() {
  return [...visible, ...(data && ui.outroMark ? [ui.outroMark] : [])];
}
