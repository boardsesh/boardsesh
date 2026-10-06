// Timeline for the spray wall walkthrough. `init(data)` builds the DOM once;
// `renderAt(frame)` writes every moving value for that frame. Every frame is a
// pure function of its number (no clocks, no state carried between frames), so
// the renderer can jump straight to any frame for stills.

import { clamp, easeInOut, easeOut, footageAt, lerp, progress, springAt } from '../showcase-video/anim.mjs';

const FPS = 30;
const FADE = 12;
const WALL_ANGLE = 30; // degrees past vertical the diagram's wall overhangs

// Scene lengths in frames. Footage scenes take their length from the edit.
const STATIC_SCENES = [
  ['intro', 105],
  ['good', 255],
  ['landscape', 180],
  ['side', 180],
  ['upright', 180],
  ['why', 210],
  ['recap', 135],
];
const OUTRO_FRAMES = 105;

let data = null;
let scenes = [];
const nodes = {};

const esc = (text) =>
  String(text).replace(
    /[&<>"]/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character],
  );

const $ = (id) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing stage node #${id}`);
  return node;
};

/** Point where a ray from `origin` along `direction` crosses the line through `a` and `b`. */
function rayHit(origin, direction, a, b) {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const denominator = direction.x * ey - direction.y * ex;
  if (Math.abs(denominator) < 1e-9) return null;
  const t = ((a.x - origin.x) * ey - (a.y - origin.y) * ex) / denominator;
  return { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
}

const rad = (degrees) => (degrees * Math.PI) / 180;
const dir = (degrees) => ({ x: Math.cos(rad(degrees)), y: Math.sin(rad(degrees)) });

/** Footage scene length: every segment played back to back, with its hold. */
const footageLength = (take) => take.segments.reduce((sum, [from, to, hold = 0]) => sum + (to - from) + hold, 0);

export function totalFrames() {
  const last = scenes[scenes.length - 1];
  return last ? last.start + last.length : 0;
}

/** Each scene's id, first frame and length, for stills and the render log. */
export function sceneList() {
  return scenes.map(({ id, start, length }) => ({ id, start, length }));
}

export function visibleImages() {
  return [...document.querySelectorAll('#stage img')].filter(
    (image) => image.closest('.scene')?.style.visibility === 'visible',
  );
}

// --- DOM ---------------------------------------------------------------------------------------

const PLYWOOD = '#d9c7a1';

function sideViewSvg(id) {
  return `
    <svg class="diagram" id="${id}" viewBox="0 0 600 420" style="left:60px;top:300px;width:600px;height:420px">
      <line x1="10" y1="380" x2="590" y2="380" stroke="var(--line)" stroke-width="4" stroke-linecap="round" />
      <polygon id="${id}-cone" fill="rgba(167,139,250,0.18)" stroke="rgba(167,139,250,0.55)" stroke-width="2" />
      <line id="${id}-wall" stroke="${PLYWOOD}" stroke-width="16" stroke-linecap="round" />
      <line id="${id}-parallel" stroke="var(--accent)" stroke-width="3" stroke-dasharray="8 10" />
      <g id="${id}-phone">
        <rect x="-11" y="-58" width="22" height="116" rx="7" fill="#2a2140" stroke="var(--ink)" stroke-width="4" />
        <rect x="9" y="-44" width="8" height="18" rx="3" fill="var(--ink)" />
      </g>
      <g id="${id}-person" stroke="var(--sub)" stroke-width="7" stroke-linecap="round" fill="none">
        <circle cx="60" cy="150" r="24" />
        <line x1="60" y1="176" x2="60" y2="285" />
        <line x1="60" y1="285" x2="38" y2="378" />
        <line x1="60" y1="285" x2="84" y2="378" />
        <polyline id="${id}-arm" points="60,200 110,240" />
      </g>
    </svg>`;
}

function topViewSvg(id) {
  return `
    <svg class="diagram" id="${id}" viewBox="0 0 600 380" style="left:60px;top:290px;width:600px;height:380px">
      <text x="300" y="40" text-anchor="middle" fill="var(--sub)" font-size="24" font-weight="700">THE WALL, FROM ABOVE</text>
      <polygon id="${id}-cone" fill="rgba(167,139,250,0.18)" stroke="rgba(167,139,250,0.55)" stroke-width="2" />
      <line x1="70" y1="90" x2="530" y2="90" stroke="${PLYWOOD}" stroke-width="16" stroke-linecap="round" />
      <g id="${id}-ghost" opacity="0.35">
        <rect x="-58" y="-11" width="116" height="22" rx="7" fill="none" stroke="var(--ink)" stroke-width="4" stroke-dasharray="8 8" />
      </g>
      <g id="${id}-phone">
        <rect x="-58" y="-11" width="116" height="22" rx="7" fill="#2a2140" stroke="var(--ink)" stroke-width="4" />
        <rect x="-44" y="-17" width="18" height="8" rx="3" fill="var(--ink)" />
      </g>
    </svg>`;
}

function ringsSvg(id, holds, missed) {
  const rings = holds
    .map((hold, index) => {
      const isMissed = missed(hold, index);
      const stroke = isMissed ? 'var(--amber)' : 'var(--accent)';
      const dash = isMissed ? ' stroke-dasharray="0.012 0.01"' : '';
      return `<circle data-ring="${index}" cx="${hold.x}" cy="${hold.y}" r="${Math.max(hold.r * 1.25, 0.018)}" fill="none" stroke="${stroke}" stroke-width="0.007"${dash} />`;
    })
    .join('');
  return `<svg id="${id}" viewBox="0 0 1 1" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">${rings}</svg>`;
}

function buildStatic(stage, copy, photo, holds) {
  const photoStyle = `background-image:url('${photo}')`;
  stage.insertAdjacentHTML(
    'beforeend',
    `
    <section class="scene" id="s-intro">
      <div class="photo" id="intro-photo" style="${photoStyle};left:0;top:0;width:720px;height:1280px;border-radius:0;opacity:0.32"></div>
      <div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(17,10,32,0.2),rgba(17,10,32,0.92) 70%)"></div>
      <div class="foot" id="intro-text" style="bottom:220px">
        <div class="eyebrow">${esc(copy.intro.eyebrow)}</div>
        <div class="title" style="font-size:84px;margin:18px 0 22px">${esc(copy.intro.title)}</div>
        <div class="body" style="font-size:34px;color:var(--ink)">${esc(copy.intro.body)}</div>
      </div>
    </section>

    <section class="scene" id="s-good">
      <div class="head"><div class="title" id="good-title">${esc(copy.good.title)}</div></div>
      <div id="good-diagram">${sideViewSvg('gd')}</div>
      <div class="foot" id="good-tips">
        ${copy.good.tips.map((tip, index) => `<div class="tip" id="good-tip-${index}"><span class="tick">✓</span>${esc(tip)}</div>`).join('')}
      </div>
      <div id="good-result" style="position:absolute;inset:0">
        <div class="phone" style="left:200px;top:250px;width:320px;height:569px">
          <div class="screen"><div class="photo" style="${photoStyle};inset:0;border-radius:0"></div></div>
        </div>
        <div class="badge good" id="good-badge" style="left:484px;top:214px">✓</div>
        <div class="caption" style="top:880px">${esc(copy.good.result)}</div>
      </div>
    </section>

    <section class="scene" id="s-landscape">
      <div class="head"><div class="title">${esc(copy.landscape.title)}</div></div>
      <div class="phone" id="ls-good" style="left:56px;top:300px;width:280px;height:498px">
        <div class="screen"><div class="photo" style="${photoStyle};inset:0;border-radius:0;box-shadow:none"></div></div>
      </div>
      <div class="phone" id="ls-bad" style="left:384px;top:300px;width:280px;height:498px">
        <div class="screen" style="display:grid;place-items:center">
          <div class="photo" style="${photoStyle};position:relative;width:100%;aspect-ratio:4/3;border-radius:0;box-shadow:none"></div>
        </div>
      </div>
      <div class="badge good" id="ls-good-badge" style="left:288px;top:266px">✓</div>
      <div class="badge bad" id="ls-bad-badge" style="left:616px;top:266px">✕</div>
      <div class="label" style="left:56px;width:280px;top:820px">Portrait</div>
      <div class="label" style="left:384px;width:280px;top:820px">Landscape</div>
      <div class="foot"><div class="body">${esc(copy.landscape.body)}</div></div>
    </section>

    <section class="scene" id="s-side">
      <div class="head"><div class="title">${esc(copy.side.title)}</div></div>
      <div id="side-diagram">${topViewSvg('sd')}</div>
      <div style="position:absolute;left:160px;top:700px;width:400px;height:400px;perspective:900px">
        <div class="photo" id="side-photo" style="${photoStyle};inset:0"></div>
      </div>
      <div class="badge bad" id="side-badge" style="left:540px;top:680px">✕</div>
      <div class="foot" style="bottom:56px"><div class="body">${esc(copy.side.body)}</div></div>
    </section>

    <section class="scene" id="s-upright">
      <div class="head"><div class="title">${esc(copy.upright.title)}</div></div>
      <div id="upright-diagram">${sideViewSvg('ud')}</div>
      <div style="position:absolute;left:180px;top:720px;width:360px;height:360px;perspective:800px">
        <div class="photo" id="upright-photo" style="${photoStyle};inset:0"></div>
      </div>
      <div class="badge bad" id="upright-badge" style="left:530px;top:700px">✕</div>
      <div class="foot" style="bottom:56px"><div class="body">${esc(copy.upright.body)}</div></div>
    </section>

    <section class="scene" id="s-why">
      <div class="head"><div class="title">${esc(copy.why.title)}</div></div>
      <div style="position:absolute;left:44px;top:330px;width:300px;height:300px">
        <div class="photo" style="${photoStyle};inset:0"></div>
        ${ringsSvg('why-good-rings', holds, () => false)}
      </div>
      <div style="position:absolute;left:376px;top:330px;width:300px;height:300px;perspective:700px">
        <div id="why-bad" style="position:absolute;inset:0;transform:rotateY(42deg) scale(0.92);transform-origin:20% 50%">
          <div class="photo" style="${photoStyle};inset:0"></div>
          ${ringsSvg('why-bad-rings', holds, (hold, index) => hold.x > 0.55 && index % 3 !== 0)}
        </div>
      </div>
      <div class="badge good" style="left:296px;top:296px" id="why-good-badge">✓</div>
      <div class="badge bad" style="left:618px;top:296px" id="why-bad-badge">✕</div>
      <div class="label" style="left:44px;width:300px;top:660px">${esc(copy.why.good)}</div>
      <div class="label" style="left:376px;width:300px;top:660px">${esc(copy.why.bad)}</div>
      <div class="foot"><div class="body">${esc(copy.why.body)}</div></div>
    </section>

    <section class="scene" id="s-recap">
      <div class="head"><div class="title">${esc(copy.recap.title)}</div></div>
      <div style="position:absolute;left:96px;right:56px;top:440px">
        ${copy.recap.items
          .map(
            (item, index) =>
              `<div class="tip" id="recap-${index}" style="font-size:48px;margin-bottom:40px"><span class="tick" style="width:64px;height:64px;font-size:38px">✓</span>${esc(item)}</div>`,
          )
          .join('')}
      </div>
    </section>`,
  );
}

function buildFootage(stage, take) {
  stage.insertAdjacentHTML(
    'beforeend',
    `
    <section class="scene" id="s-${take.id}">
      <div class="caption" id="${take.id}-title" style="top:56px"></div>
      <div class="subcaption" id="${take.id}-body" style="top:112px"></div>
      <div class="phone" style="left:76px;top:190px;width:568px;height:1010px">
        <div class="screen"><img id="${take.id}-img" alt="" /></div>
      </div>
    </section>`,
  );
}

function buildOutro(stage, copy) {
  stage.insertAdjacentHTML(
    'beforeend',
    `
    <section class="scene" id="s-outro">
      <div style="position:absolute;left:56px;right:56px;top:520px;text-align:center">
        <div class="title" style="font-size:72px">${esc(copy.outro.title)}</div>
        <div class="body" style="margin-top:28px;color:var(--accent)">${esc(copy.outro.body)}</div>
      </div>
    </section>`,
  );
}

export function init(input) {
  data = { ...input, footage: hydrateFootage(input.footage) };
  const stage = $('stage');
  stage.innerHTML = '';
  buildStatic(stage, data.copy, data.photo, data.holds);
  for (const take of data.footage) buildFootage(stage, take);
  buildOutro(stage, data.copy);

  let start = 0;
  scenes = [];
  const push = (id, length, take = null) => {
    scenes.push({ id, start, length, take });
    start += length - FADE;
  };
  for (const [id, length] of STATIC_SCENES) push(id, length);
  for (const take of data.footage) push(take.id, footageLength(take), take);
  push('outro', OUTRO_FRAMES);
  for (const scene of scenes) nodes[scene.id] = $(`s-${scene.id}`);
}

// --- per-scene renderers --------------------------------------------------------------------

const show = (node, amount) => {
  node.style.opacity = String(amount);
  node.style.transform = `translateY(${lerp(24, 0, amount)}px)`;
};

/** Draws one side-view diagram: wall overhanging WALL_ANGLE, phone at `phoneAngle` (0 = upright). */
function drawSideView(id, phoneAngle, coneOpacity, parallelOpacity) {
  const bottom = { x: 500, y: 380 };
  const height = 330;
  const top = { x: bottom.x - height * Math.tan(rad(WALL_ANGLE)), y: bottom.y - height };
  const wall = $(`${id}-wall`);
  wall.setAttribute('x1', bottom.x);
  wall.setAttribute('y1', bottom.y);
  wall.setAttribute('x2', top.x);
  wall.setAttribute('y2', top.y);

  const pivot = { x: 150, y: 250 };
  $(`${id}-phone`).setAttribute('transform', `translate(${pivot.x} ${pivot.y}) rotate(${phoneAngle})`);
  $(`${id}-arm`).setAttribute('points', `60,200 ${pivot.x - 8},${pivot.y + 10}`);

  // The camera looks out of the phone's back: the phone's right-hand normal.
  const spread = 20;
  const near = rayHit(pivot, dir(phoneAngle - spread), bottom, top);
  const far = rayHit(pivot, dir(phoneAngle + spread), bottom, top);
  const cone = $(`${id}-cone`);
  if (near && far) cone.setAttribute('points', `${pivot.x},${pivot.y} ${near.x},${near.y} ${far.x},${far.y}`);
  cone.style.opacity = String(coneOpacity);

  // A guide through the phone, parallel to the wall.
  const along = { x: (top.x - bottom.x) / height, y: (top.y - bottom.y) / height };
  const parallel = $(`${id}-parallel`);
  parallel.setAttribute('x1', pivot.x - along.x * 110);
  parallel.setAttribute('y1', pivot.y - along.y * 110);
  parallel.setAttribute('x2', pivot.x + along.x * 110);
  parallel.setAttribute('y2', pivot.y + along.y * 110);
  parallel.style.opacity = String(parallelOpacity);
}

function drawTopView(id, position, facing) {
  const wallA = { x: 70, y: 90 };
  const wallB = { x: 530, y: 90 };
  $(`${id}-ghost`).setAttribute('transform', 'translate(300 300)');
  $(`${id}-phone`).setAttribute('transform', `translate(${position.x} ${position.y}) rotate(${facing + 90})`);
  const spread = 24;
  const left = rayHit(position, dir(facing - spread), wallA, wallB);
  const right = rayHit(position, dir(facing + spread), wallA, wallB);
  if (left && right)
    $(`${id}-cone`).setAttribute('points', `${position.x},${position.y} ${left.x},${left.y} ${right.x},${right.y}`);
}

const badgePop = (node, local, at) => {
  const amount = clamp(springAt(local, at, FPS, { zeta: 0.55, period: 0.4 }), 0, 1.3);
  node.style.transform = `scale(${local < at ? 0 : amount})`;
};

const RENDERERS = {
  intro(local) {
    $('intro-photo').style.transform = `scale(${lerp(1.08, 1.0, easeOut(progress(local, 0, 105)))})`;
    show($('intro-text'), easeOut(progress(local, 8, 24)));
  },

  good(local) {
    // 0-150: the diagram, phone tilting into line with the wall, tips ticking in.
    // 150-255: the photo that shot gives.
    const tilt = easeInOut(progress(local, 20, 50));
    drawSideView('gd', lerp(0, -WALL_ANGLE, tilt), progress(local, 10, 15), progress(local, 60, 20));
    copyTips(local);
    const out = easeInOut(progress(local, 150, 20));
    $('good-diagram').style.opacity = String(1 - out);
    $('good-tips').style.opacity = String(1 - out);
    const result = easeOut(progress(local, 160, 24));
    $('good-result').style.opacity = String(result);
    $('good-result').style.transform = `translateY(${lerp(40, 0, result)}px)`;
    badgePop($('good-badge'), local, 185);
  },

  landscape(local) {
    show($('ls-good'), easeOut(progress(local, 0, 20)));
    show($('ls-bad'), easeOut(progress(local, 18, 20)));
    badgePop($('ls-good-badge'), local, 40);
    badgePop($('ls-bad-badge'), local, 60);
  },

  side(local) {
    const move = easeInOut(progress(local, 15, 45));
    const position = { x: lerp(300, 110, move), y: lerp(300, 320, move) };
    const target = { x: 300, y: 90 };
    const square = -90;
    const angled = (Math.atan2(target.y - position.y, target.x - position.x) * 180) / Math.PI;
    drawTopView('sd', position, lerp(square, angled, move));
    const skew = easeInOut(progress(local, 30, 45));
    $('side-photo').style.transform = `rotateY(${lerp(0, 46, skew)}deg) scale(${lerp(1, 0.92, skew)})`;
    badgePop($('side-badge'), local, 80);
  },

  upright(local) {
    // Start square to the wall, then straighten the phone up.
    const straighten = easeInOut(progress(local, 15, 45));
    drawSideView('ud', lerp(-WALL_ANGLE, 0, straighten), 1, 1 - straighten);
    $('upright-photo').style.transform = `rotateX(${lerp(0, -34, easeInOut(progress(local, 30, 45)))}deg)`;
    badgePop($('upright-badge'), local, 80);
  },

  why(local) {
    for (const [svgId, startAt] of [
      ['why-good-rings', 10],
      ['why-bad-rings', 40],
    ]) {
      const rings = $(svgId).querySelectorAll('circle');
      rings.forEach((ring, index) => {
        ring.style.opacity = String(progress(local, startAt + index * 1.5, 6));
      });
    }
    badgePop($('why-good-badge'), local, 70);
    badgePop($('why-bad-badge'), local, 110);
  },

  recap(local) {
    data.copy.recap.items.forEach((_, index) =>
      show($(`recap-${index}`), easeOut(progress(local, 8 + index * 14, 18))),
    );
  },

  outro() {},
};

function copyTips(local) {
  data.copy.good.tips.forEach((_, index) =>
    show($(`good-tip-${index}`), easeOut(progress(local, 30 + index * 30, 18))),
  );
}

function renderFootage(scene, local) {
  const { take } = scene;
  const index = footageAt(take.segments, local, take.count);
  const image = $(`${take.id}-img`);
  const src = take.frame(index);
  if (image.getAttribute('src') !== src) image.setAttribute('src', src);
  let caption = take.captions[0];
  for (const candidate of take.captions) if (local >= candidate.at) caption = candidate;
  const title = $(`${take.id}-title`);
  const body = $(`${take.id}-body`);
  if (title.textContent !== caption.title) title.textContent = caption.title;
  if (body.textContent !== (caption.body ?? '')) body.textContent = caption.body ?? '';
  const sinceChange = local - caption.at;
  const pop = caption === take.captions[0] ? 1 : easeOut(progress(sinceChange, 0, 12));
  title.style.opacity = String(pop);
  body.style.opacity = String(pop);
  title.style.transform = `translateY(${lerp(16, 0, pop)}px)`;
}

export function renderAt(frame) {
  if (!data) throw new Error('walkthroughInit(data) must run before renderAt');
  for (const scene of scenes) {
    const node = nodes[scene.id];
    const local = frame - scene.start;
    const visible = local >= 0 && local < scene.length;
    node.style.visibility = visible ? 'visible' : 'hidden';
    if (!visible) {
      node.style.opacity = '0';
      continue;
    }
    const fadeIn = scene.start === 0 ? 1 : progress(local, 0, FADE);
    const fadeOut = scene === scenes[scenes.length - 1] ? 1 : 1 - progress(local, scene.length - FADE, FADE);
    node.style.opacity = String(Math.min(fadeIn, fadeOut));
    if (scene.take) renderFootage(scene, local);
    else RENDERERS[scene.id](local);
  }
}

/** Adds the per-take frame lookup the stage reads; the renderer passes plain JSON. */
function hydrateFootage(footage) {
  return footage.map((take) => ({
    ...take,
    frame: (index) => `${take.dir}/f_${String(index + 1).padStart(5, '0')}.jpg`,
  }));
}
