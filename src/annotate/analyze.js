import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Chess } from "chess.js";
import { createEngine } from "../engine/stockfish.js";
import { classifyMove, classifyTerminal, CLASSIFICATION } from "./classify.js";
import { selectKeyMoments } from "./keymoments.js";
import { pickChallenge } from "./challenge.js";

const SCHEMA_VERSION = "1.1.0";
const DEFAULT_OPENING_PLIES = 10; // first 5 full moves treated as theory candidates

/**
 * End-to-end Phase 1 analysis: parsed game → annotation JSON.
 *
 * @param {{headers, result, plies: PlyInput[]}} parsed - from parsePgn()
 * @param {object} opts
 * @param {number} [opts.sweepDepth=10]
 * @param {number} [opts.keyMomentDepth=18]
 * @param {number} [opts.multiPV=3]
 * @param {number} [opts.openingPlies=10]
 * @param {(progress: {ply: number, total: number, phase: string}) => void} [opts.onProgress]
 * @returns {Promise<object>} annotation JSON conforming to the schema
 */
export async function analyzeGame(parsed, opts = {}) {
  const {
    sweepDepth = 10,
    keyMomentDepth = 18,
    multiPV = 3,
    openingPlies = DEFAULT_OPENING_PLIES,
    onProgress = () => {},
  } = opts;

  const engine = await createEngine({ multiPV });
  try {
    const plies = [];
    const positions = collectPositions(parsed.plies);

    // Sweep: evaluate every position at sweepDepth.
    const evals = new Array(positions.length);
    for (let i = 0; i < positions.length; i++) {
      onProgress({ ply: i, total: positions.length, phase: "sweep" });
      evals[i] = await engine.evaluate(positions[i], { depth: sweepDepth });
    }

    // For each ply, evalBefore = evals[i], evalAfter = evals[i+1].
    for (let i = 0; i < parsed.plies.length; i++) {
      const p = parsed.plies[i];
      const evalBefore = evals[i];
      const evalAfter = evals[i + 1];

      const isBookMove = i < openingPlies && bookHeuristic(evalBefore, p.uci);
      const terminal = terminalStateOf(p.fenAfter);
      const { classification, centipawnLoss } = terminal
        ? classifyTerminal({ evalBefore, terminal, mover: p.sideToMove })
        : classifyMove({
            evalBefore,
            evalAfter,
            playedUci: p.uci,
            bestUci: evalBefore.bestMove,
            mover: p.sideToMove,
            isBookMove,
          });

      plies.push({
        ...p,
        evalBefore,
        evalAfter,
        centipawnLoss,
        classification,
        isBookMove,
      });
    }

    // Re-evaluate key candidates at keyMomentDepth for higher-quality lines.
    // Includes both negative candidates (mistakes/blunders) and positive
    // candidates (best moves with non-trivial PV gap — possible brilliancies).
    const initialKeyMoments = selectKeyMoments(plies);
    if (keyMomentDepth > sweepDepth) {
      const indices = new Set(initialKeyMoments.map((km) => km.plyIndex));
      // Add brilliancy candidates: best moves where shallow PV gap is >50cp.
      for (const p of plies) {
        if (p.classification !== CLASSIFICATION.BEST) continue;
        if (p.isBookMove) continue;
        if (p.uci !== p.evalBefore.bestMove) continue;
        const pvs = p.evalBefore.pvLines ?? [];
        if (pvs.length < 2) continue;
        const sign = p.sideToMove === "b" ? -1 : 1;
        const v1 = pvScalar(pvs[0]);
        const v2 = pvScalar(pvs[1]);
        if (v1 == null || v2 == null) continue;
        const gap = (v1 - v2) * sign;
        if (gap > 50) indices.add(p.plyIndex);
      }
      let done = 0;
      for (const idx of indices) {
        onProgress({ ply: done++, total: indices.size, phase: "key-deep" });
        const p = plies[idx];
        const deepBefore = await engine.evaluate(p.fenBefore, { depth: keyMomentDepth });
        const deepAfter = await engine.evaluate(p.fenAfter, { depth: keyMomentDepth });
        // Re-classify with deeper evals
        const isBook = p.isBookMove;
        const terminal = terminalStateOf(p.fenAfter);
        const { classification, centipawnLoss } = terminal
          ? classifyTerminal({ evalBefore: deepBefore, terminal, mover: p.sideToMove })
          : classifyMove({
              evalBefore: deepBefore,
              evalAfter: deepAfter,
              playedUci: p.uci,
              bestUci: deepBefore.bestMove,
              mover: p.sideToMove,
              isBookMove: isBook,
            });
        plies[idx] = {
          ...p,
          evalBefore: deepBefore,
          evalAfter: deepAfter,
          centipawnLoss,
          classification,
        };
      }
    }

    // Final key-moment selection using refined evals.
    const keyMoments = selectKeyMoments(plies);

    // One "pause and think" challenge per game, if a good candidate exists.
    // Picks the latest brilliant/turning-point where the played move was
    // engine-best and the multiPV gap clearly identifies a single answer.
    const challenge = pickChallenge(plies, keyMoments);

    return {
      schemaVersion: SCHEMA_VERSION,
      mode: "game",
      engine: {
        name: "stockfish.js 18",
        flavor: "lite-single",
        sweepDepth,
        keyMomentDepth,
        multiPV,
      },
      headers: parsed.headers,
      result: parsed.result,
      plies,
      keyMoments,
      challenge,
    };
  } finally {
    await engine.quit();
  }
}

/**
 * Collect all FENs that need evaluation:
 *   - Starting FEN of the game (= plies[0].fenBefore)
 *   - fenAfter of every ply
 * So we have N+1 positions for N plies.
 */
function collectPositions(plies) {
  if (plies.length === 0) return [];
  const out = [plies[0].fenBefore];
  for (const p of plies) out.push(p.fenAfter);
  return out;
}

/**
 * Book-move heuristic: a move counts as theory if (a) we're in the opening
 * and (b) the played move is in the engine's top PV lines (engine "agrees"
 * within multiPV options). This isn't a real opening book, but it filters
 * mainline moves cheaply.
 */
function bookHeuristic(evalBefore, playedUci) {
  if (!evalBefore.pvLines) return false;
  return evalBefore.pvLines.some((pv) => pv.moves?.[0] === playedUci);
}

function pvScalar(pv) {
  if (pv.cp != null) return pv.cp;
  if (pv.mate != null) return pv.mate > 0 ? 10000 - pv.mate * 10 : -10000 - pv.mate * 10;
  return null;
}

/**
 * Inspect fenAfter; return a terminal-state tag or null if the game continues.
 */
function terminalStateOf(fenAfter) {
  try {
    const board = new Chess(fenAfter);
    if (board.isCheckmate()) return "checkmate";
    if (board.isStalemate()) return "stalemate";
    if (board.isInsufficientMaterial()) return "insufficient-material";
    if (board.isThreefoldRepetition()) return "threefold";
    if (board.isDraw()) return "draw";
    return null;
  } catch {
    return null;
  }
}

/**
 * Cache wrapper: hash inputs, write/read annotation.json from disk.
 */
export async function analyzeGameCached(parsed, opts, cacheDir) {
  const key = cacheKey(parsed, opts);
  const file = path.join(cacheDir, `${key}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (cached.schemaVersion === SCHEMA_VERSION) return { annotation: cached, fromCache: true };
  } catch {
    // miss
  }
  const annotation = await analyzeGame(parsed, opts);
  await mkdir(cacheDir, { recursive: true });
  await writeFile(file, JSON.stringify(annotation, null, 2));
  return { annotation, fromCache: false };
}

function cacheKey(parsed, opts) {
  const h = createHash("sha256");
  h.update(JSON.stringify(parsed.plies.map((p) => p.uci)));
  h.update(JSON.stringify({
    sweepDepth: opts.sweepDepth ?? 10,
    keyMomentDepth: opts.keyMomentDepth ?? 18,
    multiPV: opts.multiPV ?? 3,
    openingPlies: opts.openingPlies ?? DEFAULT_OPENING_PLIES,
  }));
  return h.digest("hex").slice(0, 16);
}
