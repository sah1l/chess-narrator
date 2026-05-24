import { Chess } from "chess.js";
import { uciToSan } from "../utils.js";

/**
 * Combine annotation + narration into a final "shot list" — the ordered
 * sequence of video shots Phase 5 will render. Each shot is self-contained:
 * everything the renderer needs (FEN, move arrows, highlights, narration
 * text, duration) is on the shot object.
 *
 * Shot kinds:
 *   - "title"                  title card (no board)
 *   - "intro"                  opening narration over the starting position
 *   - "move"                   one move on the board; compact layout for book/routine
 *   - "moment"                 one move on the board; coach treatment for critical/interesting
 *                              (engine alternative arrow, deeper info panel)
 *   - "challenge-prompt"       "Pause and think" prompt at the challenge ply
 *   - "challenge-think"        silent thinking pause (board only, no narration)
 *   - "challenge-candidate"    one of the 'why not X?' explanations (red arrow + reason)
 *   - "challenge-reveal"       the answer reveal (green arrow + explanation)
 *   - "outro"                  outro narration over the final position
 *
 * When narration.challenge is present, the challenge sequence REPLACES the
 * regular move/moment shot for that ply.
 *
 * @param {object} annotation  raw annotation JSON
 * @param {object} narration   validated narration JSON
 * @returns {{shots: object[], totalSeconds: number, title: string, subtitle: string|null}}
 */
export function buildShotList(annotation, narration) {
  const shots = [];
  const isPosition = annotation.mode === "position";

  shots.push({
    id: "title",
    kind: "title",
    title: narration.title,
    // Trim so an empty/whitespace subtitle from the LLM falls back to default
    // instead of rendering an empty card.
    subtitle: narration.subtitle?.trim() || defaultSubtitle(annotation),
    durationSec: 4,
    narration: null,
  });

  const openingFen = isPosition
    ? annotation.keyMoments[0]?.fenBefore
    : annotation.plies[0]?.fenBefore;
  const openingEval = isPosition
    ? evalFromKeyMoment(annotation.keyMoments[0])
    : evalFromEvaluation(annotation.plies[0]?.evalBefore);

  shots.push({
    id: "intro",
    kind: "intro",
    fen: openingFen,
    eval: openingEval,
    durationSec: narration.intro.estimatedSeconds,
    narration: narration.intro.text,
  });

  if (isPosition) {
    // Position mode: single explanatory shot for the one segment.
    const seg = narration.segments[0];
    const km = annotation.keyMoments[0];
    if (seg && km) {
      shots.push(buildPositionShot(km, seg, annotation));
    }
  } else {
    const kmByPly = new Map(
      (annotation.keyMoments ?? []).map((km) => [km.plyIndex, km])
    );
    const challengePly = narration.challenge?.plyIndex ?? null;
    narration.segments.forEach((seg, i) => {
      const ply = annotation.plies[i];
      const km = kmByPly.get(seg.plyIndex);
      if (challengePly != null && seg.plyIndex === challengePly) {
        // Replace this ply's normal shot with the challenge sequence.
        shots.push(...buildChallengeShots(ply, narration.challenge));
      } else {
        shots.push(buildPlyShot(ply, km, seg, i));
      }
    });
  }

  const finalFen = isPosition
    ? annotation.keyMoments[0]?.fenBefore
    : lastFen(annotation.plies);
  const finalEval = isPosition
    ? evalFromKeyMoment(annotation.keyMoments[0])
    : evalFromEvaluation(lastPly(annotation.plies)?.evalAfter);

  shots.push({
    id: "outro",
    kind: "outro",
    fen: finalFen,
    eval: finalEval,
    result: annotation.result ?? null,
    durationSec: narration.outro.estimatedSeconds,
    narration: narration.outro.text,
  });

  const totalSeconds = shots.reduce((s, sh) => s + sh.durationSec, 0);
  return {
    schemaVersion: "1.1.0",
    title: narration.title,
    subtitle: narration.subtitle?.trim() || null,
    totalSeconds,
    shots,
  };
}

/**
 * Decide which shot kind to use for a given ply.
 *   - critical (mistake/blunder/inaccuracy + brilliant + turning-point): "moment"
 *   - everything else (book, routine best/good): "move"
 */
function pickShotKindFor(ply, km) {
  if (km) return "moment"; // promoted to key moment by the analyzer
  const c = ply.classification;
  if (c === "inaccuracy" || c === "mistake" || c === "blunder") return "moment";
  return "move";
}

/**
 * Build the shot for one ply.
 *
 * Arrow rules (per user choice "only for inaccuracies+"):
 *   - Always show the played-move arrow (blue).
 *   - Show the engine's preferred move arrow (green) ONLY when:
 *       - this ply is a key moment whose engine best differs from played, OR
 *       - the classification is inaccuracy / mistake / blunder.
 */
function buildPlyShot(ply, km, seg, idx) {
  const kind = pickShotKindFor(ply, km);

  const playedArrow = ply.uci ? uciToArrow(ply.uci, "played") : null;

  // Always carry engineBest data when we have it (used by engineLine + info
  // panel). Only DRAW the engine arrow when (a) this is a moment shot and
  // (b) the engine's preferred move differs from what was played.
  const engineUci = km?.engineBest?.uci ?? ply.evalBefore?.bestMove ?? null;
  let engineBest = null;
  if (engineUci) {
    const san =
      km?.engineBest?.san ?? uciToSan(ply.fenBefore, engineUci);
    const pv = km?.engineBest?.pv ?? [engineUci];
    engineBest = { uci: engineUci, san: san ?? engineUci, pv };
  }

  const showEngineArrow =
    kind === "moment" && engineUci && engineUci !== ply.uci;
  const engineArrow = showEngineArrow
    ? uciToArrow(engineUci, "engine")
    : null;

  const arrows = [playedArrow, engineArrow].filter(Boolean);
  const highlights = (seg.highlightSquares ?? []).map((sq) => ({
    square: sq,
    color: "yellow",
  }));

  let engineLine = null;
  if (seg.showEngineLine && engineBest?.pv) {
    engineLine = expandEngineLine(ply.fenBefore, engineBest.pv, 5);
  }

  const baseId = `ply${String(ply.plyIndex).padStart(2, "0")}`;
  const moveLabel = `${ply.moveNumber}${ply.sideToMove === "w" ? "." : "..."}${ply.san}`;

  return {
    id: `${kind}-${baseId}`,
    kind,
    plyIndex: ply.plyIndex,
    depth: seg.depth ?? (kind === "moment" ? "deep" : "standard"),
    momentKind: km?.kind ?? null,
    classification: ply.classification ?? null,
    isBookMove: ply.isBookMove === true,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter ?? null,
    eval: evalFromEvaluation(ply.evalBefore),
    playedMove: { san: ply.san, uci: ply.uci },
    engineBest,
    moveLabel,
    sideToMove: ply.sideToMove,
    arrows,
    highlights,
    engineLine,
    durationSec: seg.estimatedSeconds,
    narration: seg.text,
  };
}

/**
 * Build the 4-6 shot challenge sequence for one ply:
 *   prompt → think (silent) → candidate[] → reveal
 *
 * Visual treatment:
 *   - prompt: board (no arrows), "Pause & think" headline, prompt narration
 *   - think:  board only, no info panel, no narration → silence on the audio track
 *   - candidate: board + red arrow for the wrong move, "Why not X?" treatment
 *   - reveal: board + green arrow for the answer, "The answer is X!" treatment
 */
function buildChallengeShots(ply, challenge) {
  const out = [];
  const baseId = `ply${String(ply.plyIndex).padStart(2, "0")}`;
  const moveLabel = `${ply.moveNumber}${ply.sideToMove === "w" ? "." : "..."}`;
  const moverText = ply.sideToMove === "w" ? "White to move" : "Black to move";
  // All challenge sub-shots display fenBefore of the challenge ply, so they
  // all share the eval taken from evalBefore — bar matches the displayed board.
  const challengeEval = evalFromEvaluation(ply.evalBefore);

  out.push({
    id: `challenge-prompt-${baseId}`,
    kind: "challenge-prompt",
    plyIndex: ply.plyIndex,
    fenBefore: ply.fenBefore,
    eval: challengeEval,
    sideToMove: ply.sideToMove,
    moveLabel: `${moveLabel}?`,
    moverText,
    arrows: [],
    highlights: [],
    durationSec: challenge.prompt.estimatedSeconds,
    narration: challenge.prompt.text,
  });

  const thinkSec = challenge.thinkSeconds ?? 6;
  out.push({
    id: `challenge-think-${baseId}`,
    kind: "challenge-think",
    plyIndex: ply.plyIndex,
    fenBefore: ply.fenBefore,
    eval: challengeEval,
    sideToMove: ply.sideToMove,
    moverText,
    arrows: [],
    highlights: [],
    durationSec: thinkSec,
    narration: null, // silent
  });

  challenge.candidates.forEach((cand, idx) => {
    const arrow = cand.uci ? { ...uciToArrow(cand.uci, "wrong"), label: cand.san } : null;
    out.push({
      id: `challenge-cand-${baseId}-${idx + 1}`,
      kind: "challenge-candidate",
      plyIndex: ply.plyIndex,
      candidateIndex: idx,
      fenBefore: ply.fenBefore,
      eval: challengeEval,
      sideToMove: ply.sideToMove,
      candidate: { san: cand.san, uci: cand.uci },
      arrows: arrow ? [arrow] : [],
      highlights: [],
      durationSec: cand.estimatedSeconds,
      narration: cand.text,
    });
  });

  const answerArrow = ply.uci ? { ...uciToArrow(ply.uci, "answer"), label: ply.san } : null;
  out.push({
    id: `challenge-reveal-${baseId}`,
    kind: "challenge-reveal",
    plyIndex: ply.plyIndex,
    fenBefore: ply.fenBefore,
    fenAfter: ply.fenAfter ?? null,
    eval: challengeEval,
    sideToMove: ply.sideToMove,
    answer: { san: ply.san, uci: ply.uci },
    moveLabel: `${moveLabel}${ply.san}`,
    arrows: answerArrow ? [answerArrow] : [],
    highlights: [],
    durationSec: challenge.reveal.estimatedSeconds,
    narration: challenge.reveal.text,
  });

  return out;
}

function buildPositionShot(km, seg, annotation) {
  const playedArrow = km.playedMove?.uci
    ? uciToArrow(km.playedMove.uci, "played")
    : null;
  const engineArrow =
    km.engineBest?.uci && km.engineBest.uci !== km.playedMove?.uci
      ? uciToArrow(km.engineBest.uci, "engine")
      : null;
  const arrows = [playedArrow, engineArrow].filter(Boolean);
  const highlights = (seg.highlightSquares ?? []).map((sq) => ({
    square: sq,
    color: "yellow",
  }));
  let engineLine = null;
  if (seg.showEngineLine && km.engineBest?.pv) {
    engineLine = expandEngineLine(km.fenBefore, km.engineBest.pv, 5);
  }
  return {
    id: "position",
    kind: "moment",
    plyIndex: -1,
    depth: seg.depth ?? "deep",
    momentKind: km.kind,
    fenBefore: km.fenBefore,
    fenAfter: null,
    eval: evalFromKeyMoment(km),
    playedMove: km.playedMove,
    engineBest: km.engineBest,
    moveLabel: km.playedMove?.san ?? "Position",
    sideToMove: null,
    arrows,
    highlights,
    engineLine,
    durationSec: seg.estimatedSeconds,
    narration: seg.text,
    classification: null,
  };
}

function uciToArrow(uci, role) {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci[4] : null,
    role, // "played" or "engine"
  };
}

function expandEngineLine(fen, uciPv, maxPlies) {
  const board = new Chess(fen);
  const frames = [{ fen: board.fen(), san: null, uci: null }];
  for (let i = 0; i < Math.min(uciPv.length, maxPlies); i++) {
    const u = uciPv[i];
    try {
      const m = board.move({
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        promotion: u.length > 4 ? u[4] : undefined,
      });
      if (!m) break;
      frames.push({ fen: board.fen(), san: m.san, uci: u });
    } catch {
      break;
    }
  }
  return frames;
}

function lastFen(plies) {
  if (!plies?.length) return null;
  const last = plies[plies.length - 1];
  return last.fenAfter ?? last.fenBefore;
}

function lastPly(plies) {
  return plies?.length ? plies[plies.length - 1] : null;
}

/**
 * Project a stored evaluation object down to just the bar inputs.
 * Returns { cp, mate } with both null-tolerant; null cp + null mate → bar
 * defaults to even (50/50).
 */
function evalFromEvaluation(ev) {
  if (!ev) return { cp: null, mate: null };
  return { cp: ev.cp ?? null, mate: ev.mate ?? null };
}

/**
 * Position-mode key moments don't store their own evaluation, but engineBest
 * carries the engine's PV with cp/mate at the top-level evaluation it was
 * derived from. We don't have that here, so fall back to engineBest's PV[0]
 * cp/mate when available. If absent, default to even.
 */
function evalFromKeyMoment(km) {
  if (!km) return { cp: null, mate: null };
  if (km.eval) return evalFromEvaluation(km.eval);
  return { cp: null, mate: null };
}

function defaultSubtitle(annotation) {
  if (annotation.mode === "position") return "Position study";
  const h = annotation.headers ?? {};
  const players = [h.White, h.Black].filter(Boolean).join(" vs ");
  const year = (h.Date ?? "").split(".")[0];
  if (players && year && year !== "????") return `${players} — ${year}`;
  if (players) return players;
  if (h.Event) return h.Event;
  return null;
}
