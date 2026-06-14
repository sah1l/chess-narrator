/**
 * Move classification — turn (evalBefore, evalAfter, mover) into a label.
 *
 * Inputs are evaluations from White's perspective. We flip to the mover's POV
 * internally so "centipawn loss" is intuitive (positive = bad for the mover).
 *
 * Thresholds follow Lichess-style buckets (slightly conservative on blunder):
 *   - inaccuracy: 50–99 cp loss
 *   - mistake:    100–299 cp loss
 *   - blunder:    300+ cp loss
 *
 * Mate handling: mate scores are mapped to ±10000 cp internally for arithmetic,
 * but a swing from "mate-in-N" to "mate-in-N+k" for the *same* side is NOT a
 * blunder — it's slow execution. Only swings that change the mating side, or
 * from finite cp into "getting mated", count.
 *
 * "Already lost" cap: if the mover's position was already worse than -500 cp
 * (from their POV) before the move, centipawnLoss is set to 0 — losing more
 * when you're already busted isn't useful pedagogy.
 */

const MATE_SCORE = 10000;
const ALREADY_LOST = -500;

export const CLASSIFICATION = {
  BEST: "best",
  GOOD: "good",
  INACCURACY: "inaccuracy",
  MISTAKE: "mistake",
  BLUNDER: "blunder",
  BOOK: "book",
  FORCED: "forced",
};

// Upper bound on centipawnLoss for each bucket — keeps the JSON self-consistent
// when a move was actually "best" but Stockfish's later eval at depth N differs.
const LOSS_CAP = {
  [CLASSIFICATION.BEST]: 10,
  [CLASSIFICATION.GOOD]: 49,
  [CLASSIFICATION.INACCURACY]: 99,
  [CLASSIFICATION.MISTAKE]: 299,
  [CLASSIFICATION.BLUNDER]: 1000,
  [CLASSIFICATION.BOOK]: 0,
  [CLASSIFICATION.FORCED]: 0,
};

function capLoss(classification, loss) {
  return Math.min(loss, LOSS_CAP[classification] ?? 1000);
}

/**
 * Classify a move that ended the game (checkmate / stalemate / draw).
 * The post-move position has no engine eval, so centipawn math is meaningless.
 */
export function classifyTerminal({ evalBefore, terminal, mover }) {
  if (terminal === "checkmate") {
    // Mover just delivered mate — by definition the best possible move.
    return { classification: CLASSIFICATION.BEST, centipawnLoss: 0 };
  }
  if (terminal === "stalemate") {
    // Stalemate: a draw. Was the mover winning beforehand? Then this is a blunder.
    const before = evalToCp(evalBefore, mover);
    if (before > 300) return { classification: CLASSIFICATION.BLUNDER, centipawnLoss: 1000 };
    if (before < -300) return { classification: CLASSIFICATION.BEST, centipawnLoss: 0 };
    return { classification: CLASSIFICATION.GOOD, centipawnLoss: 0 };
  }
  // Insufficient material / threefold / 50-move draw: treat as neutral.
  return { classification: CLASSIFICATION.GOOD, centipawnLoss: 0 };
}

/**
 * Convert an evaluation {cp, mate} (White's POV) to a single scalar in
 * centipawns from a chosen side's POV.
 */
export function evalToCp(ev, pov) {
  const sign = pov === "b" ? -1 : 1;
  if (ev.mate != null) {
    // mate-in-N from White's POV; convert to mover-POV centipawns.
    // Closer mate = larger magnitude.
    // mate>0: White mates in N    mate<0: Black mates in N
    // mate=0: side-to-move is checkmated (opposite side won)
    //         — equivalently positive from the winner's POV.
    const mag = MATE_SCORE - Math.min(Math.abs(ev.mate), 99) * 10;
    return ev.mate >= 0 ? sign * mag : -sign * mag;
  }
  if (ev.cp != null) return ev.cp * sign;
  return 0;
}

/**
 * Compute centipawn loss for a move.
 *
 * The mover plays a move. Before the move, the position has evalBefore (White POV).
 * After the move, it's the OPPONENT's turn, position has evalAfter (White POV).
 *
 * From the mover's POV:
 *   - The mover would prefer their score to be HIGH (in their POV).
 *   - After their move, evalAfter is from White's POV. To compare apples-to-apples,
 *     we look at both scores from the mover's POV.
 *   - centipawnLoss = beforeFromMover - afterFromMover  (positive = bad)
 */
export function centipawnLoss(evalBefore, evalAfter, mover) {
  const before = evalToCp(evalBefore, mover);
  const after = evalToCp(evalAfter, mover);
  const loss = before - after;
  // Clip negative loss (the move improved the position vs engine line — happens
  // when the played move actually was the best or near-best).
  return Math.max(0, Math.min(loss, MATE_SCORE));
}

/**
 * Classify a move given evalBefore, evalAfter, and the played move's UCI.
 *
 * @param {object} args
 * @param {{cp,mate}} args.evalBefore - White's POV
 * @param {{cp,mate}} args.evalAfter  - White's POV
 * @param {string}    args.playedUci  - UCI of the move played
 * @param {string}    args.bestUci    - engine's bestMove from the position
 * @param {"w"|"b"}   args.mover
 * @param {boolean}   [args.isBookMove]
 * @returns {{classification: string, centipawnLoss: number}}
 */
export function classifyMove({
  evalBefore,
  evalAfter,
  playedUci,
  bestUci,
  mover,
  isBookMove = false,
}) {
  if (isBookMove) {
    return { classification: CLASSIFICATION.BOOK, centipawnLoss: 0 };
  }

  // "Already lost" cap — don't pile on when the mover was already dead.
  const beforeFromMover = evalToCp(evalBefore, mover);
  if (beforeFromMover <= ALREADY_LOST) {
    const matchesBest = playedUci && bestUci && playedUci === bestUci;
    return {
      classification: matchesBest ? CLASSIFICATION.BEST : CLASSIFICATION.FORCED,
      centipawnLoss: 0,
    };
  }

  const loss = centipawnLoss(evalBefore, evalAfter, mover);

  // Mate context: if evalBefore already had a forced mate FOR the mover and
  // evalAfter still has mate for the mover (possibly slower), call it "good".
  const beforeMate = mateForMover(evalBefore, mover);
  const afterMate = mateForMover(evalAfter, mover);
  if (beforeMate != null && beforeMate > 0) {
    if (afterMate != null && afterMate > 0) {
      const matchesBest = playedUci && bestUci && playedUci === bestUci;
      const c = matchesBest ? CLASSIFICATION.BEST : CLASSIFICATION.GOOD;
      return { classification: c, centipawnLoss: 0 };
    }
    return {
      classification: CLASSIFICATION.BLUNDER,
      centipawnLoss: capLoss(CLASSIFICATION.BLUNDER, Math.max(loss, 300)),
    };
  }

  const matchesBest = playedUci && bestUci && playedUci === bestUci;
  let classification;
  if (loss < 10 || matchesBest) classification = CLASSIFICATION.BEST;
  else if (loss < 50) classification = CLASSIFICATION.GOOD;
  else if (loss < 100) classification = CLASSIFICATION.INACCURACY;
  else if (loss < 300) classification = CLASSIFICATION.MISTAKE;
  else classification = CLASSIFICATION.BLUNDER;
  return { classification, centipawnLoss: capLoss(classification, loss) };
}

function mateForMover(ev, mover) {
  if (ev.mate == null) return null;
  // ev.mate is from White's POV. Positive = White mates. Flip for Black.
  return mover === "b" ? -ev.mate : ev.mate;
}
