import { renderBoardSvg } from "./board.js";
import { renderEvalBar, EVAL_BAR_CSS } from "./evalbar.js";

/**
 * Shot HTML templates. Each shot renders as a 1920x1080 frame designed to
 * read well as a video still. Templates produce two things:
 *
 *   renderShotBody(shot, ctx) → inner HTML for one shot (no <html>/<head>)
 *   renderShotPage(shot, ctx) → complete standalone HTML document for one shot
 *   SHARED_CSS                 → CSS string used by both
 *
 * The shared body builder is reused by the preview, so layout edits land
 * everywhere at once.
 */

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;
const BOARD_SIZE = 880;
const EVAL_BAR_WIDTH = 48;
const EVAL_BAR_GAP = 20;

/**
 * Render the left-side board pane: eval bar + chessboard SVG.
 * Shots that omit `shot.eval` get a neutral (50/50) bar; title shots don't
 * call this at all.
 */
function renderBoardPane(boardOpts, shot) {
  const ev = shot?.eval ?? { cp: null, mate: null };
  return `<div class="board-pane">
    ${renderEvalBar({ cp: ev.cp, mate: ev.mate, height: BOARD_SIZE, width: EVAL_BAR_WIDTH })}
    <div class="board-wrap">${renderBoardSvg(boardOpts)}</div>
  </div>`;
}

export function renderShotPage(shot, ctx = {}) {
  const body = renderShotBody(shot, ctx);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(ctx.title ?? "Chess Game Explainer")} — ${escapeHtml(shot.id)}</title>
<style>${SHARED_CSS}</style>
</head>
<body class="frame-page">
<div class="frame">${body}</div>
</body>
</html>`;
}

export function renderShotBody(shot, ctx = {}) {
  switch (shot.kind) {
    case "title":
      return renderTitle(shot, ctx);
    case "intro":
      return renderIntro(shot, ctx);
    case "move":
      return renderMove(shot, ctx);
    case "moment":
      return renderMoment(shot, ctx);
    case "challenge-prompt":
      return renderChallengePrompt(shot, ctx);
    case "challenge-think":
      return renderChallengeThink(shot, ctx);
    case "challenge-candidate":
      return renderChallengeCandidate(shot, ctx);
    case "challenge-reveal":
      return renderChallengeReveal(shot, ctx);
    case "outro":
      return renderOutro(shot, ctx);
    default:
      return `<div class="frame-error">Unknown shot kind: ${escapeHtml(shot.kind)}</div>`;
  }
}

function renderTitle(shot) {
  const subtitle = shot.subtitle ? `<p class="title-subtitle">${escapeHtml(shot.subtitle)}</p>` : "";
  return `
<section class="shot shot-title" data-shot-id="${escapeHtml(shot.id)}">
  <div class="title-stack">
    <p class="title-eyebrow">An explainer</p>
    <h1 class="title-main">${escapeHtml(shot.title)}</h1>
    ${subtitle}
    <div class="title-rule"></div>
  </div>
</section>`;
}

function renderIntro(shot, ctx) {
  return `
<section class="shot shot-split" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({ fen: shot.fen, size: BOARD_SIZE }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")}</p>
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

/**
 * Compact move layout — for book / routine moves.
 * Clean board on the left, big move label, single line of narration.
 * No tag, no engine alternative; trusts the viewer to read the move.
 */
function renderMove(shot, ctx) {
  const subtleTag = shot.isBookMove
    ? `<span class="tag tag-book">Book</span>`
    : "";
  return `
<section class="shot shot-split shot-move" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: shot.arrows ?? [],
    highlights: shot.highlights ?? [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")}</p>
    <div class="info-headline">
      <span class="info-move info-move-compact">${escapeHtml(shot.moveLabel ?? "")}</span>
      ${subtleTag}
    </div>
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

/**
 * Heavy moment layout — for critical decisions and key moments.
 * Includes engine's preferred move when it differs from played, plus a
 * classification tag.
 */
function renderMoment(shot, ctx) {
  const tagKind = shot.momentKind ?? shot.classification ?? "neutral";
  const tagText = momentTagText(tagKind);
  const tagClass = `tag tag-${tagKind}`;
  const engineLine =
    shot.engineBest && shot.engineBest.san !== shot.playedMove?.san
      ? `<p class="info-engine">Engine preferred: <strong>${escapeHtml(shot.engineBest.san)}</strong></p>`
      : "";
  return `
<section class="shot shot-split shot-moment" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: shot.arrows ?? [],
    highlights: shot.highlights ?? [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")}</p>
    <div class="info-headline">
      <span class="info-move">${escapeHtml(shot.moveLabel ?? "")}</span>
      <span class="${tagClass}">${escapeHtml(tagText)}</span>
    </div>
    ${engineLine}
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

/**
 * Challenge: prompt the viewer to pause and find the move. No arrows on the
 * board (would give it away). Strong "Pause & Think" headline.
 */
function renderChallengePrompt(shot, ctx) {
  return `
<section class="shot shot-split shot-challenge shot-challenge-prompt" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: shot.arrows ?? [],
    highlights: shot.highlights ?? [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")} — Challenge</p>
    <div class="challenge-headline">
      <span class="challenge-pause-icon">⏸</span>
      <span class="challenge-pause-text">Pause &amp; Think</span>
    </div>
    <p class="challenge-mover">${escapeHtml(shot.moverText ?? "")}</p>
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

/**
 * Challenge: silent thinking pause. Just the board + a subtle "thinking…"
 * overlay so the viewer knows the silence is intentional. No narration audio.
 */
function renderChallengeThink(shot, ctx) {
  return `
<section class="shot shot-split shot-challenge shot-challenge-think" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: [],
    highlights: [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")} — Challenge</p>
    <div class="challenge-think-stack">
      <span class="challenge-think-icon">💭</span>
      <span class="challenge-think-text">Thinking…</span>
      <span class="challenge-think-sub">${escapeHtml(shot.moverText ?? "")}</span>
    </div>
  </div>
</section>`;
}

/**
 * Challenge: "Why not X?" — show one wrong candidate's arrow in red and
 * narrate why it doesn't work.
 */
function renderChallengeCandidate(shot, ctx) {
  const idx = (shot.candidateIndex ?? 0) + 1;
  return `
<section class="shot shot-split shot-challenge shot-challenge-candidate" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: shot.arrows ?? [],
    highlights: shot.highlights ?? [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")} — Challenge</p>
    <div class="info-headline">
      <span class="info-move">Why not ${escapeHtml(shot.candidate?.san ?? "")}?</span>
      <span class="tag tag-wrong">Candidate ${idx}</span>
    </div>
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

/**
 * Challenge: the reveal. Green arrow on the answer + "Best move!" treatment.
 */
function renderChallengeReveal(shot, ctx) {
  return `
<section class="shot shot-split shot-challenge shot-challenge-reveal" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({
    fen: shot.fenBefore,
    size: BOARD_SIZE,
    arrows: shot.arrows ?? [],
    highlights: shot.highlights ?? [],
  }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")} — Challenge</p>
    <div class="info-headline">
      <span class="info-move">${escapeHtml(shot.moveLabel ?? shot.answer?.san ?? "")}</span>
      <span class="tag tag-answer">The answer</span>
    </div>
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

function renderOutro(shot, ctx) {
  const result = shot.result ? `<p class="info-result">Result: <strong>${escapeHtml(shot.result)}</strong></p>` : "";
  return `
<section class="shot shot-split" data-shot-id="${escapeHtml(shot.id)}">
  ${renderBoardPane({ fen: shot.fen, size: BOARD_SIZE }, shot)}
  <div class="info-pane">
    <p class="info-eyebrow">${escapeHtml(ctx.title ?? "")}</p>
    ${result}
    <p class="info-narration">${escapeHtml(shot.narration ?? "")}</p>
  </div>
</section>`;
}

function momentTagText(kind) {
  switch (kind) {
    case "blunder": return "Blunder";
    case "mistake": return "Mistake";
    case "inaccuracy": return "Inaccuracy";
    case "brilliant": return "Brilliant";
    case "turning-point": return "Turning point";
    case "best": return "Best";
    case "good": return "Good";
    case "book": return "Book";
    case "forced": return "Forced";
    case "position": return "Position";
    default: return kind ?? "";
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const SHARED_CSS = `
  :root {
    --bg: #1a1f2e;
    --bg-soft: #252b3d;
    --text: #f0e6d2;
    --text-dim: #aab0c0;
    --accent: #f5b431;
    --accent-soft: #f5b43122;
    --rule: #3a4259;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #000; color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  body.frame-page { display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .frame {
    position: relative;
    width: ${FRAME_WIDTH}px;
    height: ${FRAME_HEIGHT}px;
    background: var(--bg);
    overflow: hidden;
  }
  .shot {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: stretch;
  }

  /* Title shot ------------------------------------------------------------ */
  .shot-title {
    align-items: center;
    justify-content: center;
    text-align: center;
    background: radial-gradient(ellipse at center, #2b3144 0%, var(--bg) 80%);
  }
  .title-stack { max-width: 1400px; padding: 0 80px; }
  .title-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.4em;
    font-size: 28px;
    color: var(--text-dim);
    margin: 0 0 32px;
  }
  .title-main {
    font-size: 128px;
    line-height: 1.05;
    font-weight: 700;
    margin: 0;
    letter-spacing: -0.02em;
  }
  .title-subtitle {
    font-size: 36px;
    color: var(--text-dim);
    margin: 40px 0 0;
    font-weight: 400;
  }
  .title-rule {
    margin: 64px auto 0;
    width: 140px;
    height: 4px;
    background: var(--accent);
    border-radius: 2px;
  }

  /* Split shots (intro / move / moment / outro) -------------------------- */
  .shot-split { padding: 80px; gap: 80px; }
  .board-pane {
    flex: 0 0 ${BOARD_SIZE + EVAL_BAR_WIDTH + EVAL_BAR_GAP}px;
    align-self: center;
    display: flex;
    align-items: center;
    justify-content: flex-start;
    gap: ${EVAL_BAR_GAP}px;
  }
  .board-wrap {
    width: ${BOARD_SIZE}px;
    height: ${BOARD_SIZE}px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .board-pane svg {
    width: ${BOARD_SIZE}px;
    height: ${BOARD_SIZE}px;
    border-radius: 8px;
    box-shadow: 0 24px 56px rgba(0,0,0,0.45);
  }
  ${EVAL_BAR_CSS}
  .info-pane {
    flex: 1 1 auto;
    align-self: center;
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-width: 0;
  }
  .info-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.32em;
    font-size: 18px;
    color: var(--text-dim);
    margin: 0;
  }
  .info-headline {
    display: flex;
    align-items: baseline;
    gap: 24px;
    flex-wrap: wrap;
  }
  .info-move {
    font-size: 84px;
    font-weight: 700;
    color: var(--accent);
    letter-spacing: -0.01em;
    line-height: 1;
  }
  /* Compact variant for routine move shots — board carries the weight. */
  .info-move-compact {
    font-size: 64px;
    color: var(--text);
  }
  .tag {
    font-size: 22px;
    font-weight: 600;
    padding: 8px 18px;
    border-radius: 999px;
    background: var(--bg-soft);
    border: 1px solid var(--rule);
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .tag-blunder { background: #5c1c1c; border-color: #a33232; color: #ffd9d9; }
  .tag-mistake { background: #4a2b15; border-color: #c46a26; color: #ffd9b8; }
  .tag-inaccuracy { background: #4a4015; border-color: #c4b226; color: #fff0b8; }
  .tag-best, .tag-good { background: #1c4a2b; border-color: #2faa55; color: #c9f1d5; }
  .tag-brilliant { background: #1c3a4a; border-color: #2f8caa; color: #c5e8f5; }
  .tag-turning-point { background: #3a1c4a; border-color: #7c2faa; color: #e8c5f5; }
  .tag-book { background: var(--bg-soft); border-color: var(--rule); color: var(--text-dim); font-size: 18px; padding: 6px 14px; }
  .tag-wrong { background: #5c1c1c; border-color: #e53935; color: #ffd9d9; }
  .tag-answer { background: #1c4a2b; border-color: #2faa55; color: #c9f1d5; }

  /* Challenge shots ----------------------------------------------------- */
  .shot-challenge .info-eyebrow { color: var(--accent); }
  .challenge-headline {
    display: flex;
    align-items: center;
    gap: 24px;
    margin: 0;
  }
  .challenge-pause-icon { font-size: 84px; line-height: 1; color: var(--accent); }
  .challenge-pause-text {
    font-size: 72px;
    font-weight: 700;
    letter-spacing: -0.01em;
    color: var(--accent);
    line-height: 1;
  }
  .challenge-mover {
    margin: 0;
    font-size: 32px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .shot-challenge-think .info-pane {
    justify-content: center;
  }
  .challenge-think-stack {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 18px;
  }
  .challenge-think-icon { font-size: 96px; line-height: 1; }
  .challenge-think-text {
    font-size: 72px;
    font-weight: 700;
    color: var(--text-dim);
    letter-spacing: -0.01em;
  }
  .challenge-think-sub {
    font-size: 30px;
    color: var(--text-dim);
  }
  .shot-challenge-candidate .info-move {
    font-size: 64px;
    color: #ff7e7e;
  }
  .shot-challenge-reveal .info-move {
    color: #6ee79b;
  }
  .info-engine {
    margin: 0;
    font-size: 28px;
    color: var(--text-dim);
  }
  .info-engine strong { color: var(--text); }
  .info-result {
    margin: 0;
    font-size: 30px;
    color: var(--text-dim);
  }
  .info-result strong { color: var(--accent); font-weight: 700; }
  .info-narration {
    margin: 0;
    font-size: 34px;
    line-height: 1.45;
    color: var(--text);
    max-width: 820px;
  }
  /* Compact-move narration sits a tick smaller so 1-2 sentences still feel
     intentional without dominating the board. */
  .shot-move .info-narration { font-size: 30px; }
`;
