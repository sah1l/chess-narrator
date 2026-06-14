import path from "node:path";
import { escapeHtml as _escape } from "../../utils.js";
import { winChance } from "../evalbar.js";
import { planGame, squareToXY, squareCenter } from "./board-dom.js";
import { PIECE_SVG } from "./pieces.js";

/**
 * Board color themes. `onLight`/`onDark` are the coordinate-label colors used
 * when the label sits on a light / dark square (so it always contrasts).
 * Pick one with the `theme` option (CLI: `--board-theme <name>`).
 */
export const BOARD_THEMES = {
  green: { light: "#eeeed2", dark: "#769656", onLight: "#769656", onDark: "#eeeed2" }, // chess.com
  brown: { light: "#f0d9b5", dark: "#b58863", onLight: "#b58863", onDark: "#f0d9b5" }, // lichess
  blue: { light: "#e0e7ef", dark: "#7a9cc0", onLight: "#5a7799", onDark: "#eef3f9" }, // cool slate
};
export const DEFAULT_BOARD_THEME = "green";

export function resolveBoardTheme(name) {
  return BOARD_THEMES[name] ?? BOARD_THEMES[DEFAULT_BOARD_THEME];
}

/**
 * Build a self-contained HyperFrames composition (index.html) for the
 * continuous renderer. Unlike the still renderer — which screenshots one
 * static board per shot — this produces ONE persistent board whose pieces
 * slide move-to-move and whose evaluation bar animates live, all driven by a
 * single GSAP timeline that HyperFrames seeks frame-by-frame.
 *
 * Returns { html, audio, totalSec } where `audio` lists the per-shot WAVs to
 * copy next to the html (the composition references them as "audio/<name>").
 *
 * The function is pure (no filesystem) so it can be unit-tested; the
 * orchestrator (hyperframes.js) writes the html, copies audio, and shells out
 * to `npx hyperframes render`.
 *
 * @param {object} script   enriched shot list (script.audio.json)
 * @param {object} [opts]
 * @param {number} [opts.width=1920]
 * @param {number} [opts.height=1080]
 * @returns {{ html: string, audio: {src:string,name:string}[], totalSec: number }}
 */
export function buildComposition(script, opts = {}) {
  const W = opts.width ?? 1920;
  const H = opts.height ?? 1080;
  const theme = resolveBoardTheme(opts.theme);

  // ---- Layout geometry (mirrors the still renderer's proportions) ----------
  const BOARD = 880;
  const SQ = BOARD / 8;
  const BAR_W = 40;
  const GAP = 18;
  const PAD = 70;
  const barX = PAD;
  const boardX = PAD + BAR_W + GAP;
  const boardY = Math.round((H - BOARD) / 2);
  const panelX = boardX + BOARD + 70;
  const panelW = W - panelX - PAD;

  // Animation tempo.
  const SLIDE = 0.45; // piece glide
  const EVAL_DUR = 0.5; // eval-bar ease

  const shots = script.shots ?? [];

  // ---- Walk shots, assign start times, find the move-bearing ones ----------
  const timed = [];
  let t = 0;
  for (const shot of shots) {
    const dur = Number(shot.durationSec) || 0;
    timed.push({ shot, start: round3(t), dur: round3(dur), moveIndex: null });
    t += dur;
  }
  const totalSec = round3(t);

  const moveBearing = timed.filter((e) => moveUci(e.shot) != null);
  moveBearing.forEach((e, i) => (e.moveIndex = i));
  const ucis = moveBearing.map((e) => moveUci(e.shot));

  // Starting position: the intro shot's FEN, else the first move's fenBefore.
  const introShot = shots.find((s) => s.kind === "intro");
  const startFen =
    introShot?.fen ??
    moveBearing[0]?.shot.fenBefore ??
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

  const plan = planGame(startFen, ucis);

  // Board layer is hidden during the title card, then stays up the whole game.
  const titleEntry = timed.find((e) => e.shot.kind === "title");
  const boardStart = titleEntry ? round3(titleEntry.start + titleEntry.dur) : 0;
  const boardDur = round3(Math.max(0, totalSec - boardStart));

  // ---- Pieces: initial DOM + promotion stand-ins ---------------------------
  const pieceEls = [];
  for (const p of plan.initialPieces) {
    const xy = squareToXY(p.square, SQ);
    pieceEls.push(piece(p.id, p.type, p.color, xy));
  }
  // Pre-create a promoted-piece element at each promotion's destination; it is
  // crossfaded in when the pawn arrives (deterministic — opacity only).
  const promoEls = [];
  for (const m of plan.moves) {
    if (!m || !m.promotionType) continue;
    const xy = squareToXY(m.to, SQ);
    promoEls.push(piece(`${m.moverId}-promo`, m.promotionType, m.color, xy, true));
  }

  // Home pixel of every animatable element, so GSAP tweens animate translate
  // DELTAS (target − home) on top of the element's left/top anchor.
  const homeXY = new Map();
  for (const p of plan.initialPieces) homeXY.set(p.id, squareToXY(p.square, SQ));
  for (const m of plan.moves) {
    if (m?.promotionType) homeXY.set(`${m.moverId}-promo`, squareToXY(m.to, SQ));
  }
  const delta = (id, dest) => {
    const h = homeXY.get(id) ?? { x: 0, y: 0 };
    return { x: dest.x - h.x, y: dest.y - h.y };
  };

  // ---- Arrows: pre-create one <line> per arrow, faded in during its shot ----
  const arrowEls = [];
  const arrowTweens = [];

  // ---- Captions + audio ----------------------------------------------------
  const captionEls = [];
  const audio = [];
  const audioEls = [];

  // ---- GSAP timeline tweens -------------------------------------------------
  const moveTweens = [];
  const evalTweens = [];

  const initialChance = winChance(evalOf(introShot) ?? firstEval(moveBearing));

  timed.forEach((entry, i) => {
    const { shot, start, dur, moveIndex } = entry;
    const end = round3(start + dur);
    // Alternate caption/audio track indices by shot so consecutive clips never
    // share a track — sidesteps the linter's float-boundary "overlap" check
    // (touching clips on the same track). Track index does not affect layering.
    const capTrack = 1 + (i % 2) * 2; // 1 or 3
    const audTrack = 2 + (i % 2) * 2; // 2 or 4

    // Caption (captionHtml returns "" when there is nothing to show).
    const inner = captionHtml(shot);
    if (inner) {
      const cls = shot.kind === "title" ? "clip cap cap-title" : "clip cap";
      captionEls.push(
        `<div class="${cls}" data-start="${num(start)}" data-duration="${num(dur)}" data-track-index="${capTrack}">${inner}</div>`
      );
    }

    // Audio. The renderer discovers media by id — without one the clip renders
    // SILENT — so every <audio> gets a stable id.
    if (shot.audioPath) {
      const name = `audio/${path.basename(shot.audioPath)}`;
      audio.push({ src: shot.audioPath, name });
      audioEls.push(
        `<audio id="aud-${i}" class="clip" data-start="${num(start)}" data-duration="${num(dur)}" data-track-index="${audTrack}" src="${escapeHtml(name)}" data-volume="1"></audio>`
      );
    }

    // Move slide + eval tween for move-bearing shots.
    if (moveIndex != null) {
      const m = plan.moves[moveIndex];
      const slideAt = start;
      if (m) {
        moveTweens.push(tween(m.moverId, delta(m.moverId, squareToXY(m.to, SQ)), SLIDE, slideAt, "power2.inOut"));
        if (m.castle && m.castle.rookId) {
          moveTweens.push(
            tween(m.castle.rookId, delta(m.castle.rookId, squareToXY(m.castle.to, SQ)), SLIDE, slideAt, "power2.inOut")
          );
        }
        const victim = m.capturedId ?? m.enPassantCapturedId;
        if (victim) {
          moveTweens.push(tween(victim, { opacity: 0 }, 0.15, round3(slideAt + SLIDE * 0.45)));
        }
        if (m.promotionType) {
          // Crossfade pawn → promoted piece at the destination.
          const at = round3(slideAt + SLIDE);
          moveTweens.push(tween(m.moverId, { opacity: 0 }, 0.18, at));
          moveTweens.push(tween(`${m.moverId}-promo`, { opacity: 1 }, 0.18, at));
        }
      }
      // Eval bar animates toward this move's post-move evaluation. When there
      // is no real post-move eval (e.g. checkmate has no "after" score), HOLD
      // the bar where it is instead of snapping to even — the game just ended
      // with one side fully on top.
      if (hasEval(shot.evalAfter)) {
        const after = winChance(shot.evalAfter);
        evalTweens.push(
          `tl.to("#eval-fill", { scaleY: ${num(after)}, duration: ${EVAL_DUR}, ease: "power2.out" }, ${num(slideAt)});`
        );
      }
    }

    // Arrows: engine alternative on full moments; candidate/answer on challenge.
    for (const a of arrowsFor(shot)) {
      const id = `arrow-${arrowEls.length}`;
      const el = arrowLine(id, a, SQ);
      if (!el) continue;
      arrowEls.push(el);
      const showAt = round3(moveIndex != null ? start + SLIDE : start + 0.2);
      const hideAt = round3(Math.max(showAt + 0.2, end - 0.15));
      arrowTweens.push(`tl.to("#${id}", { opacity: 0.9, duration: 0.2 }, ${num(showAt)});`);
      arrowTweens.push(`tl.to("#${id}", { opacity: 0, duration: 0.2 }, ${num(hideAt)});`);
      // Hard-kill after the fade-out so non-linear seeks past the exit can't
      // leave a stale half-faded arrow on screen.
      arrowTweens.push(`tl.set("#${id}", { opacity: 0 }, ${num(round3(hideAt + 0.2))});`);
    }
  });

  // ---- Assemble HTML --------------------------------------------------------
  const squaresHtml = boardSquares(SQ);
  const coordsHtml = boardCoords(SQ, theme);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${W}, height=${H}">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${css({ W, H, BOARD, SQ, BAR_W, barX, boardX, boardY, panelX, panelW, theme })}</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${totalSec}" data-width="${W}" data-height="${H}">

  <div id="board-layer" class="clip" data-start="${boardStart}" data-duration="${boardDur}" data-track-index="0">
    <div class="eval-bar"><div id="eval-fill" class="eval-fill" style="transform: scaleY(${num(initialChance)})"></div></div>
    <div class="board">
      ${squaresHtml}
      ${coordsHtml}
      <div class="pieces">
        ${pieceEls.join("\n        ")}
        ${promoEls.join("\n        ")}
      </div>
      <svg class="arrows" viewBox="0 0 ${BOARD} ${BOARD}" width="${BOARD}" height="${BOARD}">
        <defs>${arrowMarkers()}</defs>
        ${arrowEls.join("\n        ")}
      </svg>
    </div>
  </div>

  ${captionEls.join("\n  ")}

  ${audioEls.join("\n  ")}
</div>

<script>
  window.__timelines = window.__timelines || {};
  const tl = gsap.timeline({ paused: true });
${[...moveTweens, ...evalTweens, ...arrowTweens].map((l) => "  " + l).join("\n")}
  window.__timelines["main"] = tl;
</script>
</body>
</html>`;

  return { html, audio, totalSec };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function moveUci(shot) {
  if (shot.kind === "move" || shot.kind === "moment") return shot.playedMove?.uci ?? null;
  if (shot.kind === "challenge-reveal") return shot.answer?.uci ?? null;
  return null;
}

function evalOf(shot) {
  return shot?.eval ?? null;
}

function firstEval(moveBearing) {
  return moveBearing[0]?.shot.eval ?? {};
}

/**
 * One positioned piece element. Pieces are anchored with left/top (the home
 * square) and MOVED by GSAP x/y (translate deltas) — keeping the static CSS
 * transform-free avoids the GSAP-vs-CSS transform conflict the linter flags.
 * The body is an inline cburnett SVG (proper Staunton art with outlines) so
 * the pieces are clearly distinguishable on any square color. Hidden ones
 * (promotion stand-ins) start at opacity 0.
 */
function piece(id, type, color, xy, hidden = false) {
  const svg = PIECE_SVG[color]?.[type] ?? "";
  const cls = color === "w" ? "pc pc-w" : "pc pc-b";
  const op = hidden ? "opacity:0;" : "";
  return `<div id="${id}" class="${cls}" style="left:${xy.x}px;top:${xy.y}px;${op}">${svg}</div>`;
}

function boardSquares(sq) {
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const light = (f + r) % 2 === 0;
      const x = f * sq;
      const y = r * sq;
      out.push(
        `<div class="sq ${light ? "sq-l" : "sq-d"}" style="left:${x}px;top:${y}px"></div>`
      );
    }
  }
  return out.join("");
}

/**
 * Coordinate labels (chess.com style): file letters a–h in the bottom-right of
 * the bottom row, rank numbers 1–8 in the top-left of the left column. Each is
 * colored to contrast with the square it sits on so it relates to the board
 * and the commentary. White orientation (a-file left, rank 1 at the bottom).
 */
function boardCoords(sq, theme) {
  const files = "abcdefgh";
  const out = [];
  for (let f = 0; f < 8; f++) {
    const onLight = (f + 7) % 2 === 0; // square color at (file f, bottom row r=7)
    const color = onLight ? theme.onLight : theme.onDark;
    out.push(
      `<div class="coord coord-file" style="left:${f * sq}px;top:${7 * sq}px;color:${color}">${files[f]}</div>`
    );
  }
  for (let r = 0; r < 8; r++) {
    const onLight = r % 2 === 0; // square color at (file a=0, row r)
    const color = onLight ? theme.onLight : theme.onDark;
    out.push(
      `<div class="coord coord-rank" style="left:0;top:${r * sq}px;color:${color}">${8 - r}</div>`
    );
  }
  return out.join("");
}

/** True when an eval object carries a real score (cp or mate), not a blank. */
function hasEval(ev) {
  return !!ev && (ev.cp != null || ev.mate != null);
}

/** GSAP tween line. */
function tween(id, vars, duration, at, ease) {
  const parts = Object.entries(vars).map(([k, v]) => `${k}: ${num(v)}`);
  parts.push(`duration: ${num(duration)}`);
  if (ease) parts.push(`ease: "${ease}"`);
  return `tl.to("#${cssId(id)}", { ${parts.join(", ")} }, ${num(at)});`;
}

/** Arrows to draw for a shot (logical from/to/role). */
function arrowsFor(shot) {
  const out = [];
  if (shot.kind === "moment" && shot.pace === "full") {
    const eb = shot.engineBest;
    const played = shot.playedMove?.uci;
    if (eb?.uci && played && eb.uci !== played) {
      out.push({ from: eb.uci.slice(0, 2), to: eb.uci.slice(2, 4), role: "engine" });
    }
  } else if (shot.kind === "challenge-candidate" && shot.candidate?.uci) {
    const u = shot.candidate.uci;
    out.push({ from: u.slice(0, 2), to: u.slice(2, 4), role: "wrong" });
  } else if (shot.kind === "challenge-reveal" && shot.answer?.uci) {
    const u = shot.answer.uci;
    out.push({ from: u.slice(0, 2), to: u.slice(2, 4), role: "answer" });
  }
  return out;
}

const ARROW_COLOR = {
  engine: "#43a047",
  wrong: "#e53935",
  answer: "#2faa55",
  played: "#1e88e5",
};

function arrowLine(id, a, sq) {
  const from = squareCenter(a.from, sq);
  const to = squareCenter(a.to, sq);
  if (!from || !to) return null;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return null;
  const shrink = sq * 0.22;
  const x2 = to.x - (dx / len) * shrink;
  const y2 = to.y - (dy / len) * shrink;
  const color = ARROW_COLOR[a.role] ?? ARROW_COLOR.played;
  return `<line id="${id}" x1="${r1(from.x)}" y1="${r1(from.y)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${color}" stroke-width="${r1(sq * 0.16)}" stroke-linecap="round" opacity="0" marker-end="url(#ah-${a.role})"></line>`;
}

function arrowMarkers() {
  return Object.entries(ARROW_COLOR)
    .map(
      ([role, color]) =>
        `<marker id="ah-${role}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`
    )
    .join("");
}

/** Right-panel caption inner HTML by shot kind. Empty string → no caption. */
function captionHtml(shot) {
  switch (shot.kind) {
    case "title":
      return `<div class="title-eyebrow">An explainer</div><div class="title-main">${escapeHtml(shot.title ?? "")}</div>${shot.subtitle ? `<div class="title-sub">${escapeHtml(shot.subtitle)}</div>` : ""}`;
    case "intro":
      return `<p class="narration">${escapeHtml(shot.narration ?? "")}</p>`;
    case "outro":
      return `${shot.result ? `<p class="result">Result: <strong>${escapeHtml(shot.result)}</strong></p>` : ""}<p class="narration">${escapeHtml(shot.narration ?? "")}</p>`;
    case "move":
    case "moment": {
      const label = shot.moveLabel ? `<div class="move-label ${shot.pace === "full" ? "" : "move-label-sm"}">${escapeHtml(shot.moveLabel)}</div>` : "";
      const tag = shot.kind === "moment" && shot.pace === "full" ? momentTag(shot) : "";
      const eng =
        shot.pace === "full" && shot.engineBest && shot.engineBest.san !== shot.playedMove?.san
          ? `<p class="engine">Engine preferred <strong>${escapeHtml(shot.engineBest.san)}</strong></p>`
          : "";
      const narr = shot.narration ? `<p class="narration">${escapeHtml(shot.narration)}</p>` : "";
      if (!narr && shot.pace === "silent") return label; // silent: just the move label
      return `<div class="headline">${label}${tag}</div>${eng}${narr}`;
    }
    case "challenge-prompt":
      return `<div class="challenge-head"><span class="challenge-icon">⏸</span><span>Pause &amp; Think</span></div>${shot.moverText ? `<p class="mover">${escapeHtml(shot.moverText)}</p>` : ""}<p class="narration">${escapeHtml(shot.narration ?? "")}</p>`;
    case "challenge-think":
      return `<div class="challenge-think">💭<span>Thinking…</span></div>`;
    case "challenge-candidate":
      return `<div class="headline"><div class="move-label wrong">Why not ${escapeHtml(shot.candidate?.san ?? "")}?</div></div><p class="narration">${escapeHtml(shot.narration ?? "")}</p>`;
    case "challenge-reveal":
      return `<div class="headline"><div class="move-label answer">${escapeHtml(shot.moveLabel ?? shot.answer?.san ?? "")}</div><span class="tag tag-answer">The answer</span></div><p class="narration">${escapeHtml(shot.narration ?? "")}</p>`;
    default:
      return "";
  }
}

function momentTag(shot) {
  const kind = shot.momentKind ?? shot.classification ?? "";
  if (!kind) return "";
  const text = {
    blunder: "Blunder",
    mistake: "Mistake",
    inaccuracy: "Inaccuracy",
    brilliant: "Brilliant",
    "turning-point": "Turning point",
    best: "Best",
    good: "Good",
  }[kind] ?? kind;
  return `<span class="tag tag-${kind}">${escapeHtml(text)}</span>`;
}

function css(L) {
  return `
  :root { --bg:#1a1f2e; --bg-soft:#252b3d; --text:#f0e6d2; --dim:#aab0c0; --accent:#f5b431; --rule:#3a4259; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${L.W}px; height:${L.H}px; overflow:hidden; background:var(--bg); color:var(--text);
    font-family: ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing:antialiased; }
  #root { position:absolute; inset:0; }
  #board-layer { position:absolute; inset:0; }

  .eval-bar { position:absolute; left:${L.barX}px; top:${L.boardY}px; width:${L.BAR_W}px; height:${L.BOARD}px;
    background:#1f2330; border-radius:6px; overflow:hidden; box-shadow:0 12px 28px rgba(0,0,0,.35); }
  .eval-fill { position:absolute; left:0; right:0; bottom:0; height:100%; transform-origin:bottom;
    background:linear-gradient(to top,#fafafa 0%,#e6e6e6 100%); }

  .board { position:absolute; left:${L.boardX}px; top:${L.boardY}px; width:${L.BOARD}px; height:${L.BOARD}px;
    border-radius:8px; overflow:hidden; box-shadow:0 24px 56px rgba(0,0,0,.45); }
  .sq { position:absolute; width:${L.SQ}px; height:${L.SQ}px; }
  .sq-l { background:${L.theme.light}; } .sq-d { background:${L.theme.dark}; }
  .coord { position:absolute; width:${L.SQ}px; height:${L.SQ}px; display:flex;
    font-size:${Math.round(L.SQ * 0.21)}px; font-weight:700; line-height:1; pointer-events:none; }
  .coord-file { align-items:flex-end; justify-content:flex-end; padding:0 7px 5px 0; }
  .coord-rank { align-items:flex-start; justify-content:flex-start; padding:6px 0 0 7px; }
  .pieces { position:absolute; inset:0; }
  .pc { position:absolute; left:0; top:0; width:${L.SQ}px; height:${L.SQ}px; display:flex; align-items:center; justify-content:center;
    will-change:transform; }
  .pc svg { width:88%; height:88%; display:block; overflow:visible;
    filter:drop-shadow(0 ${(L.SQ * 0.02).toFixed(1)}px ${(L.SQ * 0.018).toFixed(1)}px rgba(0,0,0,.32)); }
  .arrows { position:absolute; left:0; top:0; pointer-events:none; }

  .cap { position:absolute; left:${L.panelX}px; top:0; width:${L.panelW}px; height:100%;
    display:flex; flex-direction:column; justify-content:center; gap:22px; padding:60px 0; }
  .cap-title { left:0; width:100%; align-items:center; text-align:center; padding:0 120px; gap:28px; }
  .title-eyebrow { text-transform:uppercase; letter-spacing:.4em; font-size:26px; color:var(--dim); }
  .title-main { font-size:120px; font-weight:700; line-height:1.04; letter-spacing:-.02em; }
  .title-sub { font-size:34px; color:var(--dim); }

  .headline { display:flex; align-items:baseline; gap:22px; flex-wrap:wrap; }
  .move-label { font-size:76px; font-weight:700; color:var(--accent); line-height:1; }
  .move-label-sm { font-size:52px; color:var(--text); }
  .move-label.wrong { color:#ff7e7e; font-size:56px; }
  .move-label.answer { color:#6ee79b; font-size:64px; }
  .engine { font-size:28px; color:var(--dim); }
  .engine strong { color:var(--text); }
  .narration { font-size:34px; line-height:1.45; color:var(--text); max-width:${Math.min(L.panelW, 760)}px; }
  .result { font-size:30px; color:var(--dim); }
  .result strong { color:var(--accent); }
  .mover { font-size:30px; color:var(--dim); }

  .tag { font-size:22px; font-weight:600; padding:8px 18px; border-radius:999px; background:var(--bg-soft);
    border:1px solid var(--rule); text-transform:uppercase; letter-spacing:.1em; }
  .tag-blunder { background:#5c1c1c; border-color:#a33232; color:#ffd9d9; }
  .tag-mistake { background:#4a2b15; border-color:#c46a26; color:#ffd9b8; }
  .tag-inaccuracy { background:#4a4015; border-color:#c4b226; color:#fff0b8; }
  .tag-brilliant { background:#1c3a4a; border-color:#2f8caa; color:#c5e8f5; }
  .tag-turning-point { background:#3a1c4a; border-color:#7c2faa; color:#e8c5f5; }
  .tag-best, .tag-good { background:#1c4a2b; border-color:#2faa55; color:#c9f1d5; }
  .tag-answer { background:#1c4a2b; border-color:#2faa55; color:#c9f1d5; }

  .challenge-head { display:flex; align-items:center; gap:20px; font-size:64px; font-weight:700; color:var(--accent); }
  .challenge-icon { font-size:72px; }
  .challenge-think { display:flex; align-items:center; gap:20px; font-size:64px; font-weight:700; color:var(--dim); }
  `;
}

function escapeHtml(s) {
  if (s == null) return "";
  return _escape(String(s));
}

// numeric formatting — keep generated JS/HTML tidy and deterministic.
function num(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "0";
  return String(Math.round(n * 1000) / 1000);
}
function round3(n) {
  return Math.round(n * 1000) / 1000;
}
function r1(n) {
  return Math.round(n * 10) / 10;
}
function cssId(id) {
  return String(id).replace(/"/g, '\\"');
}
