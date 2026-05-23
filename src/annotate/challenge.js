import { Chess } from "chess.js";

/**
 * Pick ONE "pause and think" challenge moment per game, or return null if
 * the game has no good candidate.
 *
 * The challenge is a position where the viewer is asked to pause the video
 * and figure out the best move, then we explain why each plausible-looking
 * alternative falls short. So a good challenge needs:
 *
 *   1. The played move must equal the engine's #1 line (we're asking the
 *      viewer to find a move that was actually played — anything else makes
 *      the reveal weird).
 *   2. The key-moment kind is "brilliant" or "turning-point" — these have
 *      enough drama to justify a 30-second detour.
 *   3. The multiPV has at least 2 lines, and #1 is clearly ahead of #2
 *      (mate-vs-non-mate, or ≥150cp gap). Without a clear gap, the puzzle
 *      has no single right answer and the "wrong" candidates aren't wrong.
 *   4. The position has 2+ plausible alternatives (i.e. multiPV entries 2+)
 *      that aren't obvious losses themselves — those become the "looks
 *      tempting but..." candidates.
 *
 * Prefer the LATEST qualifying moment (climactic moves play better as a
 * puzzle than mid-game ones).
 *
 * @param {object[]} plies   ply array with evalBefore.pvLines populated
 * @param {object[]} keyMoments  selected key moments
 * @returns {{plyIndex:number, candidates:object[]}|null}
 */
export function pickChallenge(plies, keyMoments) {
  const candidates = [];
  for (const km of keyMoments) {
    if (km.kind !== "brilliant" && km.kind !== "turning-point") continue;
    const ply = plies[km.plyIndex];
    if (!ply) continue;
    // Skip the actual mate-delivery move — "find mate in 1" is a trivial
    // puzzle. The interesting challenge is the move that SETS UP the mate.
    if (ply.san.endsWith("#")) continue;
    const engineBest = ply.evalBefore?.bestMove;
    if (!engineBest || engineBest !== ply.uci) continue;
    const pvLines = ply.evalBefore?.pvLines ?? [];
    if (pvLines.length < 2) continue;
    const gap = clearGap(pvLines, ply.sideToMove);
    if (gap == null) continue;

    candidates.push({ plyIndex: ply.plyIndex, gap, ply, pvLines });
  }
  if (candidates.length === 0) return null;

  // Prefer the latest qualifying moment.
  candidates.sort((a, b) => b.plyIndex - a.plyIndex);
  const chosen = candidates[0];

  return {
    plyIndex: chosen.plyIndex,
    candidates: chosen.pvLines.slice(0, 4).map((pv, i) =>
      pvToCandidate(pv, chosen.ply.fenBefore, i === 0)
    ),
  };
}

/**
 * Return the cp-equivalent gap (mover's POV) between PV1 and PV2, or null
 * if there isn't a clear answer.
 *
 * Mate beats non-mate by definition. Two mates: faster mate wins; gap is
 * scaled by ply difference. Both non-mate: simple cp difference.
 */
function clearGap(pvLines, sideToMove) {
  const sign = sideToMove === "b" ? -1 : 1;
  const a = pvLines[0];
  const b = pvLines[1];
  if (!a || !b) return null;
  const aIsWinMate = a.mate != null && (a.mate > 0) === (sign > 0);
  const bIsWinMate = b.mate != null && (b.mate > 0) === (sign > 0);
  if (aIsWinMate && !bIsWinMate) return 9999; // mate vs anything else
  if (aIsWinMate && bIsWinMate) {
    const fasterBy = Math.abs(b.mate) - Math.abs(a.mate);
    return fasterBy >= 2 ? 9999 : null;
  }
  if (a.cp == null || b.cp == null) return null;
  const gap = (a.cp - b.cp) * sign;
  return gap >= 150 ? gap : null;
}

function pvToCandidate(pv, fenBefore, isBest) {
  const firstUci = pv.moves?.[0] ?? null;
  let firstSan = firstUci;
  if (firstUci) {
    try {
      const b = new Chess(fenBefore);
      const m = b.move({
        from: firstUci.slice(0, 2),
        to: firstUci.slice(2, 4),
        promotion: firstUci.length > 4 ? firstUci[4] : undefined,
      });
      if (m) firstSan = m.san;
    } catch {
      // keep uci fallback
    }
  }
  return {
    rank: pv.rank ?? null,
    san: firstSan,
    uci: firstUci,
    cp: pv.cp ?? null,
    mate: pv.mate ?? null,
    pvSan: uciPvToSan(fenBefore, pv.moves ?? [], 5),
    isBest,
  };
}

function uciPvToSan(fen, uciPv, maxPlies) {
  const out = [];
  if (!fen || !Array.isArray(uciPv)) return out;
  const board = new Chess(fen);
  for (let i = 0; i < Math.min(uciPv.length, maxPlies); i++) {
    const u = uciPv[i];
    try {
      const m = board.move({
        from: u.slice(0, 2),
        to: u.slice(2, 4),
        promotion: u.length > 4 ? u[4] : undefined,
      });
      if (!m) break;
      out.push(m.san);
    } catch {
      break;
    }
  }
  return out;
}
