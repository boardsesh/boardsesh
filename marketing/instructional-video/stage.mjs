import { easeOut, lerp } from '../showcase-video/anim.mjs';

const node = (id) => document.getElementById(id);
let loadedImage = '';
window.renderTutorialAt = async (frame, scene) => {
  const beat = scene.beat;
  for (const id of ['phone', 'label', 'caption']) node(id).hidden = !beat;
  node('bookend').hidden = Boolean(beat);
  node('title').textContent = beat ? beat.chapterTitle : scene.title;
  node('label').textContent = beat?.label ?? '';
  node('caption').textContent = beat?.narration ?? '';
  node('draft').textContent = scene.draft ? 'DRAFT / SILENT / REVIEW BEFORE POSTING' : '';
  node('progress').style.transform = `scaleX(${frame / Math.max(1, scene.totalFrames - 1)})`;
  node('bookend-title').textContent = scene.outro ? 'See you on the wall.' : 'Make your next session count.';
  node('bookend-copy').textContent = scene.outro
    ? 'Save this for your next session. boardsesh.com'
    : 'Follow along. Try these moves in the app.';
  if (!beat) return;
  if (loadedImage !== scene.image) {
    await new Promise((resolve, reject) => {
      node('screen').onload = resolve;
      node('screen').onerror = () => reject(new Error('Recorded frame could not load'));
      node('screen').src = scene.image;
    });
    loadedImage = scene.image;
  }
  const width = scene.width;
  const height = scene.height;
  const focus = scene.focus ?? { x: 0, y: 0, width: 1, height: 1 };
  const zoom = easeOut(Math.min(1, scene.elapsedFrames / 24));
  const fullScale = Math.min(790 / width, 550 / height);
  const focusScale = Math.min(790 / (focus.width * width), 550 / (focus.height * height));
  const scale = lerp(fullScale, Math.min(focusScale, fullScale * 3.6), zoom);
  const centerX = lerp(0.5, focus.x + focus.width / 2, zoom);
  const centerY = lerp(0.5, focus.y + focus.height / 2, zoom);
  const offsetX = 395 - centerX * width * scale;
  const offsetY = 275 - centerY * height * scale;
  node('screen').style.transform = `translate(${offsetX}px,${offsetY}px) scale(${scale})`;
  node('ring').hidden = !scene.anchor;
  if (scene.anchor) {
    const anchor = scene.anchor;
    Object.assign(node('ring').style, {
      left: `${offsetX + anchor.x * width * scale}px`,
      top: `${offsetY + anchor.y * height * scale}px`,
      width: `${anchor.width * width * scale}px`,
      height: `${anchor.height * height * scale}px`,
      opacity: String(zoom),
    });
  }
};
