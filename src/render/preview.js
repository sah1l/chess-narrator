import path from "node:path";
import { renderShotBody, SHARED_CSS, FRAME_WIDTH, FRAME_HEIGHT } from "./templates.js";

/**
 * Build a single-file HTML preview that plays the whole sequence in any
 * browser. The preview includes:
 *   - All shot HTML inlined as <div class="frame"> elements
 *   - Audio elements for shots that have an audioPath
 *   - A controller (top bar) with play/pause, progress, prev/next
 *   - Auto-advances to the next shot when audio ends (or after durationSec
 *     for shots with no audio)
 *
 * Audio paths in the input script are absolute (Windows filesystem paths).
 * The preview must reference them via relative paths from previewDir so the
 * browser can fetch them on file:// or http://.
 *
 * @param {object} script        enriched script (from synthesizeScript)
 * @param {object} opts
 * @param {string} opts.previewDir  absolute directory where preview.html will be written
 * @returns {string} full HTML document
 */
export function renderPreviewHtml(script, { previewDir }) {
  if (!previewDir) throw new Error("renderPreviewHtml: previewDir is required");

  const ctx = { title: script.title };
  const shotEls = script.shots
    .map((shot, i) => {
      const body = renderShotBody(shot, ctx);
      const audioPath = shot.audioPath ? toForwardSlash(path.relative(previewDir, shot.audioPath)) : null;
      const audio = audioPath
        ? `<audio data-shot-index="${i}" preload="auto" src="${audioPath}"></audio>`
        : "";
      return `<div class="slide" data-shot-index="${i}" data-duration-ms="${Math.round(shot.durationSec * 1000)}">${body}${audio}</div>`;
    })
    .join("\n");

  const shotMeta = JSON.stringify(
    script.shots.map((s) => ({
      id: s.id,
      kind: s.kind,
      durationSec: s.durationSec,
      hasAudio: !!s.audioPath,
    }))
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Preview: ${escapeAttr(script.title)}</title>
<style>${SHARED_CSS}${PREVIEW_CSS}</style>
</head>
<body>
<header class="controls">
  <button id="btn-play" type="button">▶ Play</button>
  <button id="btn-prev" type="button">‹ Prev</button>
  <button id="btn-next" type="button">Next ›</button>
  <span id="shot-label">— / —</span>
  <span id="time-label">0.0s</span>
  <div class="progress"><div id="progress-bar"></div></div>
  <span class="meta">${escapeAttr(script.title)} · ${formatTotal(script.totalSeconds)}</span>
</header>
<main class="stage-wrap">
  <div class="stage" id="stage">
    ${shotEls}
  </div>
</main>
<script>
  const SHOTS = ${shotMeta};
  const stage = document.getElementById('stage');
  const slides = [...stage.querySelectorAll('.slide')];
  const audios = [...document.querySelectorAll('audio[data-shot-index]')];
  const audioByIndex = new Map(audios.map((a) => [Number(a.dataset.shotIndex), a]));
  const totalMs = SHOTS.reduce((s, sh) => s + sh.durationSec * 1000, 0);
  const totalShots = SHOTS.length;

  let current = 0;
  let playing = false;
  let timer = null;
  let shotStartedAt = 0;

  function fitStage() {
    const wrap = document.querySelector('.stage-wrap');
    const sx = wrap.clientWidth / ${FRAME_WIDTH};
    const sy = wrap.clientHeight / ${FRAME_HEIGHT};
    const s = Math.min(sx, sy);
    stage.style.transform = 'scale(' + s + ')';
    stage.style.left = ((wrap.clientWidth - ${FRAME_WIDTH} * s) / 2) + 'px';
    stage.style.top = ((wrap.clientHeight - ${FRAME_HEIGHT} * s) / 2) + 'px';
  }
  window.addEventListener('resize', fitStage);
  fitStage();

  function show(i) {
    slides.forEach((sl, idx) => sl.style.display = idx === i ? 'block' : 'none');
    document.getElementById('shot-label').textContent =
      (i + 1) + ' / ' + totalShots + '  ·  ' + SHOTS[i].id;
  }

  function pauseAll() {
    audios.forEach((a) => { a.pause(); a.currentTime = 0; });
    if (timer) { clearTimeout(timer); timer = null; }
    playing = false;
    document.getElementById('btn-play').textContent = '▶ Play';
  }

  function playShot(i) {
    current = i;
    show(i);
    shotStartedAt = performance.now();
    const dur = SHOTS[i].durationSec * 1000;
    const audio = audioByIndex.get(i);
    if (audio) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    }
    timer = setTimeout(() => {
      if (!playing) return;
      if (current + 1 < totalShots) playShot(current + 1);
      else pauseAll();
    }, dur);
  }

  function togglePlay() {
    if (playing) {
      pauseAll();
    } else {
      playing = true;
      document.getElementById('btn-play').textContent = '⏸ Pause';
      playShot(current);
    }
  }

  function go(delta) {
    pauseAll();
    current = Math.max(0, Math.min(totalShots - 1, current + delta));
    show(current);
  }

  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-prev').addEventListener('click', () => go(-1));
  document.getElementById('btn-next').addEventListener('click', () => go(1));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') go(-1);
    else if (e.code === 'ArrowRight') go(1);
  });

  // progress + time labels
  function tick() {
    let elapsedBefore = 0;
    for (let i = 0; i < current; i++) elapsedBefore += SHOTS[i].durationSec * 1000;
    const inShot = playing ? Math.min(performance.now() - shotStartedAt, SHOTS[current].durationSec * 1000) : 0;
    const total = elapsedBefore + inShot;
    document.getElementById('progress-bar').style.width = (100 * total / totalMs) + '%';
    document.getElementById('time-label').textContent = (total / 1000).toFixed(1) + 's';
    requestAnimationFrame(tick);
  }
  tick();
  show(0);
</script>
</body>
</html>`;
}

const PREVIEW_CSS = `
  body { background: #0a0d14; overflow: hidden; height: 100vh; display: flex; flex-direction: column; }
  .controls {
    flex: 0 0 auto;
    display: flex;
    gap: 12px;
    align-items: center;
    padding: 10px 16px;
    background: #11151f;
    border-bottom: 1px solid #232938;
    font-size: 14px;
  }
  .controls button {
    background: #232938;
    border: 1px solid #38405a;
    color: var(--text);
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 14px;
    cursor: pointer;
    font-family: inherit;
  }
  .controls button:hover { background: #2d344a; }
  #shot-label, #time-label, .meta { color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .meta { margin-left: auto; }
  .progress { flex: 1 1 auto; height: 6px; background: #232938; border-radius: 3px; overflow: hidden; max-width: 480px; }
  #progress-bar { height: 100%; background: var(--accent); width: 0%; transition: width 0.05s linear; }
  .stage-wrap {
    flex: 1 1 auto;
    position: relative;
    overflow: hidden;
  }
  .stage {
    position: absolute;
    width: ${FRAME_WIDTH}px;
    height: ${FRAME_HEIGHT}px;
    transform-origin: top left;
  }
  .slide {
    width: ${FRAME_WIDTH}px;
    height: ${FRAME_HEIGHT}px;
    background: var(--bg);
    display: none;
  }
  .slide audio { display: none; }
`;

function toForwardSlash(p) {
  return p.split(path.sep).join("/");
}

function escapeAttr(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function formatTotal(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return m > 0 ? `${m}m${s.toString().padStart(2, "0")}s` : `${s}s`;
}
