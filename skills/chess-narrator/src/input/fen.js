import { Chess } from "chess.js";
import { createEngine } from "../engine/stockfish.js";

const SCHEMA_VERSION = "1.0.0";

/**
 * Validate a FEN string. Throws on malformed input.
 * @returns {{fen: string, sideToMove: "w"|"b", inCheck: boolean, terminal: string|null}}
 */
export function validateFen(fen) {
  if (typeof fen !== "string") throw new Error("FEN must be a string");
  const trimmed = fen.trim();
  let board;
  try {
    board = new Chess(trimmed);
  } catch (e) {
    throw new Error(`Invalid FEN: ${e.message}`);
  }
  let terminal = null;
  if (board.isCheckmate()) terminal = "checkmate";
  else if (board.isStalemate()) terminal = "stalemate";
  else if (board.isInsufficientMaterial()) terminal = "insufficient-material";
  else if (board.isDraw()) terminal = "draw";
  return {
    fen: board.fen(),
    sideToMove: board.turn(),
    inCheck: board.inCheck(),
    terminal,
  };
}

/**
 * Single-position annotation. Produces the same top-level shape as a game
 * annotation but with `mode: "position"`, an empty `plies` array, and exactly
 * one entry in `keyMoments` describing the position + engine plan.
 *
 * @param {string} fen
 * @param {object} opts
 * @param {number} [opts.depth=20]      single deep evaluation
 * @param {number} [opts.multiPV=3]
 * @returns {Promise<object>} annotation JSON conforming to schema
 */
export async function analyzePosition(fen, opts = {}) {
  const { depth = 20, multiPV = 3 } = opts;
  const info = validateFen(fen);
  if (info.terminal) {
    return positionAnnotation({ fen: info.fen, info, evaluation: null, depth, multiPV });
  }

  const engine = await createEngine({ multiPV });
  let evaluation;
  try {
    evaluation = await engine.evaluate(info.fen, { depth });
  } finally {
    await engine.quit();
  }
  return positionAnnotation({ fen: info.fen, info, evaluation, depth, multiPV });
}

function positionAnnotation({ fen, info, evaluation, depth, multiPV }) {
  const sideName = info.sideToMove === "w" ? "White" : "Black";
  let headline;
  if (info.terminal === "checkmate") {
    const winner = info.sideToMove === "w" ? "Black" : "White";
    headline = `Final position — ${winner} delivered checkmate.`;
  } else if (info.terminal === "stalemate") {
    headline = `Stalemate — ${sideName} has no legal moves and is not in check.`;
  } else if (info.terminal) {
    headline = `Drawn position by ${info.terminal}.`;
  } else {
    const evalStr = formatEval(evaluation);
    headline = `${sideName} to move${info.inCheck ? " (in check)" : ""}. Engine eval: ${evalStr}.`;
  }

  const engineBest = evaluation
    ? buildEngineBest(evaluation, info.fen)
    : null;

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "position",
    engine: {
      name: "stockfish.js 18",
      flavor: "lite-single",
      sweepDepth: depth,
      keyMomentDepth: depth,
      multiPV,
    },
    headers: {},
    result: null,
    plies: [],
    keyMoments: [
      {
        plyIndex: -1,
        kind: "position",
        fenBefore: fen,
        headline,
        playedMove: null,
        engineBest,
        evalSwing: null,
      },
    ],
  };
}

function buildEngineBest(evaluation, fen) {
  if (!evaluation || !evaluation.bestMove) return null;
  const uci = evaluation.bestMove;
  let san = uci;
  try {
    const board = new Chess(fen);
    const m = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (m) san = m.san;
  } catch {
    // keep uci fallback
  }
  return {
    uci,
    san,
    pv: evaluation.pvLines?.[0]?.moves ?? [uci],
  };
}

function formatEval(ev) {
  if (!ev) return "n/a";
  if (ev.mate != null) {
    return ev.mate > 0 ? `mate in ${ev.mate}` : `mated in ${-ev.mate}`;
  }
  if (ev.cp != null) {
    const v = (ev.cp / 100).toFixed(2);
    return ev.cp >= 0 ? `+${v}` : v;
  }
  return "n/a";
}
