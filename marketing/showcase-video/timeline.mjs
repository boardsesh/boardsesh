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
} from './anim.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Per-format placements that are not phone poses. */
const LAYOUT = {
  '16x9': {
    motif: { cx: 1430, cy: 540, maxWidth: 660, maxHeight: 700 },
    grid: { cx: 1430, cy: 540, rx: 600, ry: 560 },
    glow: { hook: [1430, 540, 1.0, 0.55], boards: [960, 720, 2.1, 1], outro: [960, 470, 1.15, 0.6] },
    outro: { mark: 150, wordmark: 338, dots: 566, tagline: 646, pill: 790, dotsHalfWidth: 300, zig: 16 },
    boardLabelGap: 30,
  },
  '9x16': {
    motif: { cx: 540, cy: 1200, maxWidth: 760, maxHeight: 900 },
    grid: { cx: 540, cy: 1200, rx: 620, ry: 760 },
    glow: { hook: [540, 1200, 1.2, 0.55], boards: [540, 1220, 1.5, 1], outro: [540, 860, 1.1, 0.6] },
    outro: { mark: 470, wordmark: 668, dots: 862, tagline: 940, pill: 1086, dotsHalfWidth: 260, zig: 16 },
    boardLabelGap: 22,
  },
};

const SCENE_POSE = {
  hook: 'OFF_RIGHT',
  light: 'CALLOUT',
  boards: 'BOARDS_MID',
  wall: 'CALLOUT',
  crew: 'CALLOUT',
  workouts: 'HERO_TILT',
  'lock-screen': 'CALLOUT',
  log: 'CALLOUT',
  outro: 'OFF_RIGHT',
};

/** The pile-up's small, fixed untidiness: per-slot tilt (deg) and drop (px). */
const JITTER_RZ = [-4, 3, -2, 4, -3, 2, -4, 3];
const JITTER_Y = [10, -8, 12, -6, 8, -12, 6, -4];
/** Springs: the neat rise, the newcomers' quicker, bouncier arrival, and the nudges. */
const ARRIVE = { zeta: 0.62, period: 0.42 };
const NUDGE = { zeta: 0.5, period: 0.5 };

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

/** A phone rig plus its shadow, in the phones layer (which carries the stage perspective). */
function buildPhone(layer, zIndex) {
  const shadow = el('div', { class: 'phone-shadow' }, layer);
  const rig = el('div', { class: 'phone-rig' }, layer);
  setVars(rig, { z: zIndex });
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
  return { rig, img, shadow };
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

const POSE_KEYS = ['cx', 'cy', 'scale', 'rx', 'ry', 'rz'];

/**
 * Keyframes are { frame, pose, spring? }. Each key adds the step from the
 * previous key's pose as its own spring, released at its frame, and the steps
 * superpose. So a phone nudged again before it has settled carries on from
 * where it is instead of jumping, and a settled phone lands exactly on its key.
 */
function poseAt(keys, frame) {
  const pose = { ...keys[0].pose };
  for (let index = 1; index < keys.length; index += 1) {
    const key = keys[index];
    if (frame < key.frame) break;
    const amount = spring((frame - key.frame) / data.fps, key.spring);
    for (const name of POSE_KEYS) pose[name] += (key.pose[name] - keys[index - 1].pose[name]) * amount;
  }
  return pose;
}

const sortKeys = (keys) => keys.sort((a, b) => a.frame - b.frame);

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
const release = (scene) => scene.startFrame - data.choreo.backgroundLeadIn;

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

// --- the boards pile-up -----------------------------------------------------------

/**
 * Where each board phone sits when `present` (left-to-right) are on stage.
 * Up to three stand neatly; past that they shrink and crowd, overlapping, with
 * a little fixed tilt so the row reads as a jostle that has just settled.
 */
function boardSlots(present) {
  const count = present.length;
  const slots = new Map();
  if (data.format === '16x9') {
    if (count <= 3) {
      const offsets = count === 1 ? [0] : count === 2 ? [-190, 190] : [-380, 0, 380];
      present.forEach((takeId, index) => {
        const middle = count !== 2 && index === (count - 1) / 2;
        slots.set(takeId, { cx: 960 + offsets[index], cy: middle ? 700 : 730, scale: 0.78, rx: 0, ry: 0, rz: 0 });
      });
      return slots;
    }
    const scale = 0.78 - (count - 3) * 0.036;
    const width = data.phone.width * scale;
    const spacing = Math.min(380, (1760 - width) / (count - 1));
    present.forEach((takeId, index) => {
      slots.set(takeId, {
        cx: 960 + (index - (count - 1) / 2) * spacing,
        cy: 716 + JITTER_Y[index % JITTER_Y.length],
        scale,
        rx: 0,
        ry: 0,
        rz: JITTER_RZ[index % JITTER_RZ.length],
      });
    });
    return slots;
  }
  // 9:16: a fan for up to three, then two overlapping rows.
  if (count <= 3) {
    const poses =
      count === 1
        ? [data.poses.BOARDS_MID]
        : count === 2
          ? [
              { ...data.poses.BOARDS_LEFT, cx: 360 },
              { ...data.poses.BOARDS_RIGHT, cx: 720 },
            ]
          : [data.poses.BOARDS_LEFT, data.poses.BOARDS_MID, data.poses.BOARDS_RIGHT];
    present.forEach((takeId, index) => slots.set(takeId, { ...poses[index] }));
    return slots;
  }
  const back = present.filter((_, index) => index % 2 === 0);
  const front = present.filter((_, index) => index % 2 === 1);
  const spread = (row, from, to) => (index) =>
    row.length === 1 ? 540 : from + (index * (to - from)) / (row.length - 1);
  const backX = spread(back, 170, 910);
  const frontX = spread(front, 250, 830);
  back.forEach((takeId, index) =>
    slots.set(takeId, {
      cx: backX(index),
      cy: 900 + JITTER_Y[index % JITTER_Y.length],
      scale: 0.5,
      rx: 0,
      ry: 0,
      rz: JITTER_RZ[index % JITTER_RZ.length],
    }),
  );
  front.forEach((takeId, index) =>
    slots.set(takeId, {
      cx: frontX(index),
      cy: 1320 + JITTER_Y[(index + 3) % JITTER_Y.length],
      scale: 0.56,
      rx: 0,
      ry: 0,
      rz: JITTER_RZ[(index + 3) % JITTER_RZ.length],
    }),
  );
  return slots;
}

/**
 * Keyframes for every board phone, keyed by take. The neat phones rise with
 * the scene change; each newcomer slides in from its side (the last one pops
 * up from below, into the gap it forces open) and every phone already there
 * springs to its new, tighter slot. The squeeze kicks its two neighbours. Nothing
 * enters from above: a dark phone crossing the dark headline would hide it.
 */
function buildBoardKeys(boardsScene) {
  const plan = data.boards;
  const start = boardsScene.startFrame;
  const keys = new Map(plan.arrival.map((takeId) => [takeId, []]));
  const presentAfter = (arrivalIndex) => {
    const arrived = new Set(plan.arrival.slice(0, Math.max(arrivalIndex + 1, plan.neatCount)));
    return plan.final.filter((takeId) => arrived.has(takeId));
  };
  const mainFinal = plan.final.indexOf(plan.main);
  const last = plan.arrival.length - 1;
  plan.arrival.forEach((takeId, arrivalIndex) => {
    const frame = start + plan.arrivalFrames[arrivalIndex];
    const slots = boardSlots(presentAfter(arrivalIndex));
    const target = slots.get(takeId);
    const neat = arrivalIndex < plan.neatCount;
    const squeeze = !neat && arrivalIndex === last && last > plan.neatCount;
    if (takeId !== plan.main) {
      const fromLeft = plan.final.indexOf(takeId) < mainFinal;
      const entrance = neat
        ? { ...target, cy: target.cy + data.height * 0.85 }
        : squeeze
          ? { ...target, cy: target.cy + data.height * 0.9, rz: -12 }
          : { ...target, cx: fromLeft ? -420 : data.width + 420, rz: fromLeft ? -22 : 22 };
      keys.get(takeId).push({ frame: -Infinity, pose: entrance });
    }
    keys.get(takeId).push({ frame, pose: target, spring: neat ? undefined : ARRIVE });
    if (neat) return;
    // Everyone already on stage makes room.
    const final = plan.final;
    for (const other of plan.arrival.slice(0, arrivalIndex)) {
      const slot = slots.get(other);
      keys.get(other).push({ frame, pose: slot, spring: NUDGE });
      if (!squeeze) continue;
      const distance = final.indexOf(other) - final.indexOf(takeId);
      if (Math.abs(distance) !== 1) continue;
      // The squeeze bumps its neighbours outward and makes them wobble.
      const kick = { ...slot, cx: slot.cx + distance * 26, cy: slot.cy - 14, rz: slot.rz + distance * 7 };
      keys.get(other).push({ frame: frame + 3, pose: kick, spring: NUDGE });
      keys.get(other).push({ frame: frame + 8, pose: slot, spring: NUDGE });
    }
  });
  // Exit: the side phones sink away a frame apart, clear before the persistent one moves on at L-4.
  plan.arrival.forEach((takeId, arrivalIndex) => {
    if (takeId === plan.main) return;
    const list = keys.get(takeId);
    const settled = list[list.length - 1].pose;
    list.push({
      frame: boardsScene.endFrame - 16 + arrivalIndex,
      pose: { ...settled, cy: settled.cy + data.height * 0.9 },
    });
  });
  for (const list of keys.values()) sortKeys(list);
  return keys;
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
  setVars(stage, {
    'role-start-light': data.lightRoles.start,
    'role-hand-light': data.lightRoles.hand,
    'role-finish-light': data.lightRoles.finish,
  });

  for (const layer of stage.querySelectorAll('svg.layer')) {
    layer.setAttribute('viewBox', `0 0 ${data.width} ${data.height}`);
  }

  // Phones: one per board take, the persistent one last so it sits where the
  // other scenes expect it. Later arrivals stack on top of earlier ones.
  const phoneLayer = document.getElementById('phones');
  const boardsScene = sceneById('boards');
  ui.boardPhones = new Map();
  data.boards.arrival.forEach((takeId, arrivalIndex) => {
    if (takeId === data.boards.main) return;
    ui.boardPhones.set(takeId, buildPhone(phoneLayer, 2 + arrivalIndex));
  });
  ui.main = buildPhone(phoneLayer, 2 + data.boards.arrival.indexOf(data.boards.main));

  const poses = data.poses;
  const boardKeys = buildBoardKeys(boardsScene);
  ui.boardKeys = boardKeys;
  ui.mainKeys = [{ frame: -Infinity, pose: poses[SCENE_POSE[data.scenes[0].id]] }];
  for (const scene of data.scenes.slice(1)) {
    if (scene.id === 'boards') ui.mainKeys.push(...boardKeys.get(data.boards.main));
    else ui.mainKeys.push({ frame: release(scene), pose: poses[SCENE_POSE[scene.id]] });
  }
  sortKeys(ui.mainKeys);

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

  // Board labels, one per phone.
  ui.boardLabels = new Map(
    data.boards.arrival.map((takeId) => [
      takeId,
      el('div', { class: 'board-label', text: data.boards.labels[takeId] ?? takeId }, ui.text),
    ]),
  );

  // Callouts: light scenes draw the darker role hues on a bordered white pill.
  ui.sceneCallouts = {};
  for (const scene of data.scenes) {
    const tone = scene.background === 'light' ? 'tone-light' : 'tone-dark';
    ui.sceneCallouts[scene.id] = scene.callouts.map((callout) => {
      const group = svg('g', { class: `callout ${tone}`, 'data-role': callout.role }, ui.callouts);
      const box = svg('rect', { class: 'callout-box', rx: 14, pathLength: 1 }, group);
      const leader = svg('path', { class: 'callout-leader', pathLength: 1 }, group);
      const dot = svg('circle', { r: 3 }, group);
      const pill = el(
        'div',
        {
          class: `pill callout ${tone}`,
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

  // Workouts checklist: a pyramid, ticking, with a rest countdown after the top set.
  const workouts = data.copy.workouts;
  const checklist = el('div', { class: 'checklist on-dark' }, ui.text);
  ui.checklist = checklist;
  ui.rows = workouts.rows.map((row, index) => {
    const node = el('div', { class: 'row' }, checklist);
    const check = el('div', { class: 'check' }, node);
    const checkSvg = svg('svg', { viewBox: '0 0 36 36', width: 36, height: 36 }, check);
    svg('circle', { class: 'ring', cx: 18, cy: 18, r: 16.75 }, checkSvg);
    const fill = svg('circle', { class: 'fill', cx: 18, cy: 18, r: 0 }, checkSvg);
    const tick = svg('path', { class: 'tick', d: 'M10.5 18.5 L15.8 23.5 L25.5 12.8', pathLength: 1 }, checkSvg);
    const chip = el('span', { class: 'chip', text: row.grade }, node);
    const grade = data.grades[row.grade.replace(/\+$/, '')] ?? { background: '#808080', ink: '#000000' };
    setVars(chip, { 'chip-bg': grade.background, 'chip-ink': grade.ink });
    el('span', { class: 'name', text: row.name }, node);
    const restCell = el('span', { class: 'rest' }, node);
    const time = el('span', { class: 'time', text: row.rest }, restCell);
    let timer = null;
    if (index === data.workout.restRow) {
      // The countdown: a draining amber ring and one prebuilt label per value.
      const pill = el('span', { class: 'rest-timer' }, restCell);
      const ringSvg = svg('svg', { viewBox: '0 0 28 28', width: 28, height: 28 }, pill);
      svg('circle', { class: 'rest-track', cx: 14, cy: 14, r: 11 }, ringSvg);
      const ring = svg('circle', { class: 'rest-ring', cx: 14, cy: 14, r: 11, pathLength: 1 }, ringSvg);
      el('span', { class: 'rest-label', text: workouts.restLabel }, pill);
      const digits = el('span', { class: 'rest-digits' }, pill);
      const values = workouts.restCountdown.map((value) => el('span', { class: 'digit', text: value }, digits));
      timer = { pill, ring, values };
    }
    return { node, fill, tick, time, timer };
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

/** The persistent phone's footage: its scene's take, else the neighbour it is arriving from or leaving to. */
function mainTake(sceneIndex) {
  const pick = (scene) => (scene.id === 'boards' ? data.boards.main : scene.takes[0]);
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

function applyPhone(phone, pose, takeRef, frame, footageOpacity) {
  const { rig, img, shadow } = phone;
  setVars(rig, {
    cx: pose.cx,
    cy: pose.cy,
    s: pose.scale,
    rx: pose.rx,
    ry: pose.ry,
    rz: pose.rz,
    'footage-o': footageOpacity,
  });
  setVars(shadow, { cx: pose.cx, cy: pose.cy + 452 * pose.scale, s: pose.scale });
  if (!takeRef || !onCanvas(pose)) return;
  const take = data.takes[takeRef.takeId];
  if (!take) return;
  const src = frameUrl(take, footageIndex(take, takeRef.scene, frame));
  if (img.getAttribute('src') !== src) img.src = src;
  if (footageOpacity > 0) visible.push(img);
}

function renderHeadlines(frame) {
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
      // Same geometry as render.ts leaderPoints / layoutPortraitPills: a side exit, or a
      // riser from the box top when running sideways would cut through another box.
      const { exit, laneY, gutterX, slotY } = item.callout;
      const centreX = box.x + box.width / 2;
      if (data.format === '16x9') {
        pillX = data.layout.pillX;
        points =
          exit === 'top'
            ? [
                { x: centreX, y: box.y },
                { x: centreX, y: laneY },
                { x: gutterX, y: laneY },
                { x: gutterX, y: slotY },
                { x: pillX, y: slotY },
              ]
            : [
                { x: box.x + box.width, y: centreY },
                { x: gutterX, y: centreY },
                { x: gutterX, y: slotY },
                { x: pillX, y: slotY },
              ];
      } else {
        const inset = data.layout.portraitPillInset;
        const width = data.layout.portraitPillWidth;
        const leftSide = item.callout.side === 'left';
        const pillEdge = leftSide ? inset + width : data.width - inset - width;
        pillX = leftSide ? inset : pillEdge;
        if (exit === 'top') {
          points = [
            { x: centreX, y: box.y },
            { x: centreX, y: slotY },
            { x: pillEdge, y: slotY },
          ];
        } else {
          const startX = leftSide ? box.x : box.x + box.width;
          const middle = (startX + pillEdge) / 2;
          points = [
            { x: startX, y: centreY },
            { x: middle, y: centreY },
            { x: middle, y: slotY },
            { x: pillEdge, y: slotY },
          ];
        }
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

function renderBoards(frame, boardPoses) {
  const scene = sceneById('boards');
  const local = frame - scene.startFrame;
  const on = frame >= scene.startFrame - 2 && frame < scene.endFrame + 4;
  const out = wordsOut(scene, local);
  data.boards.arrival.forEach((takeId, arrivalIndex) => {
    const label = ui.boardLabels.get(takeId);
    const pose = boardPoses.get(takeId);
    if (!on || !pose) {
      setVars(label, { o: 0 });
      return;
    }
    const arrival = Math.max(14 + 4 * arrivalIndex, data.boards.arrivalFrames[arrivalIndex] + 10);
    const amount = easeOut(progress(local, arrival, 12));
    setVars(label, {
      lx: pose.cx,
      ly: pose.cy - (data.phone.height / 2) * pose.scale - layout.boardLabelGap - 30,
      o: amount * (1 - out),
      b: 10 * (1 - amount) + 10 * out,
      y: 14 * (1 - amount),
    });
  });
}

function renderWorkouts(frame) {
  const scene = sceneById('workouts');
  const local = frame - scene.startFrame;
  const on = frame >= scene.startFrame && frame < scene.endFrame;
  setVars(ui.checklist, { on: on ? 1 : 0 });
  if (!on) return;
  const out = wordsOut(scene, local);
  const beats = data.workout;
  let ticked = 0;
  ui.rows.forEach((row, index) => {
    const enter = data.workoutBeats.rowsIn + data.workoutBeats.rowStagger * index;
    const amount = easeOut(progress(local, enter, 12));
    const tickAt = beats.ticks[index];
    const fill = easeOut(progress(local, tickAt, 8));
    const tick = easeInOut(progress(local, tickAt + 3, 8));
    ticked += fill;
    const current = local >= (beats.ticks[index - 1] ?? 0) && local < tickAt + 4;
    setVars(row.node, {
      o: amount * (1 - out),
      b: 10 * (1 - amount) + 12 * out,
      x: -24 * (1 - amount),
      hi: current && amount > 0.99 ? 1 : 0,
    });
    setAttrs(row.fill, { r: 18 * fill });
    setAttrs(row.tick, { 'stroke-dasharray': `${tick.toFixed(4)} 1`, opacity: tick > 0.001 ? 1 : 0 });
    if (!row.timer) return;
    // The rest countdown replaces this row's rest time between the top set and this row's tick.
    const shown = easeOut(progress(local, beats.restStart, 6)) * (1 - easeIn(progress(local, beats.restEnd, 5)));
    const run = progress(local, beats.restStart + 2, beats.restEnd - beats.restStart - 4);
    setVars(row.timer.pill, { 'timer-o': shown });
    setVars(row.time, { 'time-o': 1 - shown });
    setAttrs(row.timer.ring, { 'stroke-dasharray': `${(1 - run).toFixed(4)} 1`, opacity: run < 0.999 ? 1 : 0 });
    const step = Math.min(row.timer.values.length - 1, Math.floor(run * (row.timer.values.length - 1) + 1e-6));
    row.timer.values.forEach((value, valueIndex) => setVars(value, { 'digit-on': valueIndex === step ? 1 : 0 }));
  });
  const lastRowIn = data.workoutBeats.rowsIn + data.workoutBeats.rowStagger * (ui.rows.length - 1);
  setVars(ui.progressTrack, { 'track-o': easeOut(progress(local, lastRowIn, 12)) * (1 - out) });
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

function renderMeasure(frame, sceneIndex, mainPose, boardPoses) {
  if (!data.measure) return;
  const main = mainTake(sceneIndex);
  const boards = sceneById('boards');
  const shown = new Map();
  if (main) shown.set(main.takeId, { pose: mainPose, scene: main.scene });
  if (frame >= boards.startFrame && frame < boards.endFrame) {
    for (const [takeId, pose] of boardPoses) shown.set(takeId, { pose, scene: boards });
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
    const point = projectPoint(mainPose, hold.local.x, hold.local.y, projection());
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
  const lightScene = sceneById('light');
  const footageOpacity = frame < lightScene.endFrame ? easeOut(progress(frame, lightScene.startFrame + 8, 14)) : 1;
  applyPhone(ui.main, mainPose, mainTake(sceneIndex), frame, footageOpacity);
  const boards = sceneById('boards');
  const boardPoses = new Map([[data.boards.main, mainPose]]);
  for (const [takeId, phone] of ui.boardPhones) {
    const pose = poseAt(ui.boardKeys.get(takeId), frame);
    boardPoses.set(takeId, pose);
    applyPhone(phone, pose, { takeId, scene: boards }, frame, 1);
  }

  const glow = poseAt(ui.glowKeys, frame);
  for (const node of ui.glows) setVars(node, { gx: glow.cx, gy: glow.cy, gs: glow.scale, gstrength: glow.rx });

  renderHeadlines(frame);
  renderCallouts(frame, sceneIndex, mainPose);
  renderBoards(frame, boardPoses);
  renderWorkouts(frame);
  const outroState = renderOutro(frame);
  renderMotif(frame, mainPose, outroState);
  renderMeasure(frame, sceneIndex, mainPose, boardPoses);
  return frame;
}

/** The footage images the current frame shows, so the renderer can await their decode. */
export function visibleImages() {
  return [...visible, ...(data && ui.outroMark ? [ui.outroMark] : [])];
}
