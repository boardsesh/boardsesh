/**
 * Full-bleed layout: each clip's footage fills the frame (object-fit: cover,
 * so 800x1738 footage covers 886x1920 with 2 px cropped top and bottom), with
 * the clip's caption bar sliding in over it. Like timeline.mjs, every frame is
 * a pure function of its number: renderAt only sets `img.src` and CSS custom
 * properties. The data comes from render.ts `FullBleedStageData`.
 */
import { easeIn, easeOut, footageAt, progress } from './anim.mjs';

let data = null;
const ui = {};

const setVars = (node, vars) => {
  for (const [key, value] of Object.entries(vars)) {
    node.style.setProperty(`--${key}`, typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : value);
  }
};

const frameUrl = (take, index) => `${take.frameUrlBase}${String(index + 1).padStart(5, '0')}.jpg`;

export function init(input) {
  data = input;
  const stage = document.getElementById('stage');
  stage.style.width = `${data.width}px`;
  stage.style.height = `${data.height}px`;
  ui.stage = stage;
  ui.footage = document.createElement('img');
  ui.footage.className = 'footage';
  ui.footage.alt = '';
  stage.appendChild(ui.footage);
  ui.caption = document.createElement('div');
  ui.caption.className = 'caption';
  stage.appendChild(ui.caption);
  setVars(ui.caption, {
    inset: data.bar.inset,
    height: data.bar.height,
    radius: data.bar.radius,
    size: data.bar.fontSize,
  });
}

const clipIndexAt = (frame) => {
  const index = data.clips.findIndex((clip) => frame >= clip.startFrame && frame < clip.endFrame);
  return index === -1 ? data.clips.length - 1 : index;
};

export function renderAt(frame) {
  if (!data) throw new Error('showcaseInit(data) must run before renderAt');
  const index = clipIndexAt(frame);
  const clip = data.clips[index];
  const local = frame - clip.startFrame;
  const length = clip.endFrame - clip.startFrame;
  const src = frameUrl(clip.take, footageAt(clip.take.segments, local, clip.take.frameCount));
  if (ui.footage.getAttribute('src') !== src) ui.footage.src = src;

  if (ui.caption.dataset.clip !== String(index)) {
    ui.caption.dataset.clip = String(index);
    ui.caption.textContent = clip.caption;
    setVars(ui.caption, { top: clip.captionTop });
  }
  // In: a short drop and fade from the clip's start. Out: a fade before the hard cut.
  const enter = easeOut(progress(local, data.bar.inFrom, data.bar.inFrames));
  const leave = easeIn(progress(local, length - data.bar.outFrames, data.bar.outFrames));
  setVars(ui.caption, { o: enter * (1 - leave), y: -18 * (1 - enter) });
}

export function visibleImages() {
  return [ui.footage];
}

/** The caption bar's rect when it is showing, for the renderer's text checks. */
export function textBoxes() {
  const opacity = Number.parseFloat(getComputedStyle(ui.caption).opacity);
  if (opacity < 0.05) return [];
  const rect = ui.caption.getBoundingClientRect();
  return [{ label: ui.caption.textContent ?? '', x: rect.x, y: rect.y, width: rect.width, height: rect.height }];
}
