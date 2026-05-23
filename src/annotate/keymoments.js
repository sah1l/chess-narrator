import { Chess } from "chess.js";
import { CLASSIFICATION, evalToCp } from "./classify.js";

const SEVERITY = {
  [CLASSIFICATION.BLUNDER]: 4,
  [CLASSIFICATION.MISTAKE]: 3,
  [CLASSIFICATION.INACCURACY]: 2,
  [CLASSIFICATION.GOOD]: 1,
  [CLASSIFICATION.BEST]: 1,
  [CLASSIFICATION.BOOK]: 0,
  [CLASSIFICATION.FORCED]: 0,
};

/**
 * Select 4-7 key moments from a sequence of annotated plies.
 *
 *   - All blunders and mistakes are candidates (heaviest weight).
 *   - 1-2 strong moments (best-defense, turning-point, brilliant) so the
 *     narration isn't pure negativity.
 *   - If the game has too few mistakes, top off with the largest CP swings.
 *
 * Returns an array of keyMoment objects shaped per the annotation schema.
 */
export function selectKeyMoments(plies, { target = 6, min = 4, max = 7 } = {}) {
  const candidates = plies
    .filter((p) => p.classification !== CLASSIFICATION.BOOK)
    .map((p) => ({ ply: p, score: scoreCandidate(p) }))
    .sort((a, b) => b.score - a.score);

  // Pick the top N, then look for at least one positive moment to balance.
  const picked = new Map(); // plyIndex -> {ply, kind}

  for (const { ply } of candidates) {
    if (picked.size >= target) break;
    const kind = kindForPly(ply);
    if (!kind) continue;
    picked.set(ply.plyIndex, { ply, kind });
  }

  // Pick 1–3 positive moments (turning point / brilliant / mate) so the
  // narration isn't pure negativity. See findPositiveMoments for the priority
  // order (mate delivery > mate transition > earliest of cluster).
  const positives = findPositiveMoments(plies, picked, { maxPositives: 3 });
  for (const pos of positives) {
    if (picked.size < max) {
      picked.set(pos.ply.plyIndex, pos);
    } else {
      // swap out the lowest-weighted existing negative
      const ordered = [...picked.entries()].sort(
        (a, b) =>
          SEVERITY[a[1].ply.classification] -
          SEVERITY[b[1].ply.classification]
      );
      if (ordered.length && SEVERITY[ordered[0][1].ply.classification] < 3) {
        picked.delete(ordered[0][0]);
        picked.set(pos.ply.plyIndex, pos);
      }
    }
  }

  // Top up to min using additional positives (more permissive threshold) or
  // small inaccuracies; clamp to max; sort chronologically.
  if (picked.size < min) {
    const extras = findPositiveMoments(plies, picked, { maxPositives: min - picked.size });
    for (const e of extras) picked.set(e.ply.plyIndex, e);
  }
  let chosen = [...picked.values()].sort(
    (a, b) => a.ply.plyIndex - b.ply.plyIndex
  );
  if (chosen.length > max) chosen = chosen.slice(0, max);

  return chosen.map(({ ply, kind }) => buildKeyMoment(ply, kind));
}

function scoreCandidate(p) {
  return SEVERITY[p.classification] * 100 + Math.min(p.centipawnLoss, 800);
}

function kindForPly(p) {
  switch (p.classification) {
    case CLASSIFICATION.BLUNDER:
      return "blunder";
    case CLASSIFICATION.MISTAKE:
      return "mistake";
    case CLASSIFICATION.INACCURACY:
      return "inaccuracy";
    default:
      return null;
  }
}

function findPositiveMoments(plies, alreadyPicked, { maxPositives = 3 } = {}) {
  // Brilliancy candidates: BEST + matched-engine + large PV-1 vs PV-2 gap.
  // PV gap is the "only-move" signal that survives high-depth analysis.
  const candidates = [];
  for (const p of plies) {
    if (alreadyPicked.has(p.plyIndex)) continue;
    if (p.isBookMove) continue;
    if (
      p.classification !== CLASSIFICATION.BEST &&
      p.classification !== CLASSIFICATION.GOOD
    )
      continue;
    if (p.uci !== p.evalBefore.bestMove) continue;
    const pvs = p.evalBefore.pvLines ?? [];
    if (pvs.length < 2) continue;
    const sign = p.sideToMove === "b" ? -1 : 1;
    const v1 = pvToCp(pvs[0]);
    const v2 = pvToCp(pvs[1]);
    if (v1 == null || v2 == null) continue;
    const gap = (v1 - v2) * sign;
    if (gap < 150) continue;
    candidates.push({ ply: p, gap, pv1IsMate: pvs[0].mate != null });
  }
  candidates.sort((a, b) => a.ply.plyIndex - b.ply.plyIndex);

  // Cluster consecutive candidates (≤3 plies apart) so we don't double-pick
  // moves from the same forcing sequence.
  const clusters = [];
  for (const c of candidates) {
    const last = clusters[clusters.length - 1];
    if (last && c.ply.plyIndex - last[last.length - 1].ply.plyIndex <= 3) {
      last.push(c);
    } else {
      clusters.push([c]);
    }
  }

  // Prioritized picks:
  //   priority 0 — checkmate-delivery move (always show the finish)
  //   priority 1 — mate-transition move within a cluster (engine first sees mate)
  //   priority 2 — earliest of clusters with no mate transition (start of combination)
  const picks = [];

  for (const p of plies) {
    if (alreadyPicked.has(p.plyIndex)) continue;
    if (p.san.endsWith("#")) {
      picks.push({ ply: p, kind: "brilliant", priority: 0, score: 1_000_000 });
    }
  }

  for (const cluster of clusters) {
    let transitionIdx = -1;
    for (let i = 0; i < cluster.length; i++) {
      if (cluster[i].pv1IsMate && (i === 0 || !cluster[i - 1].pv1IsMate)) {
        transitionIdx = i;
        break;
      }
    }
    if (transitionIdx >= 0) {
      const t = cluster[transitionIdx];
      picks.push({ ply: t.ply, kind: "brilliant", priority: 1, score: t.gap });
      // For long forcing sequences (cluster of 4+), also include the start —
      // it's the move that initiated the combination, distinct from the move
      // where mate first appears.
      if (cluster.length >= 4 && cluster[0].ply.plyIndex !== t.ply.plyIndex) {
        const e = cluster[0];
        const kind = e.gap >= 400 ? "brilliant" : "turning-point";
        picks.push({ ply: e.ply, kind, priority: 2, score: e.gap });
      }
    } else {
      const e = cluster[0];
      const kind = e.gap >= 400 ? "brilliant" : "turning-point";
      picks.push({ ply: e.ply, kind, priority: 2, score: e.gap });
    }
  }

  picks.sort((a, b) => a.priority - b.priority || b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const pk of picks) {
    if (seen.has(pk.ply.plyIndex)) continue;
    seen.add(pk.ply.plyIndex);
    out.push(pk);
    if (out.length >= maxPositives) break;
  }
  return out;
}

function pvToCp(pv) {
  if (pv.cp != null) return pv.cp;
  if (pv.mate != null) return pv.mate > 0 ? 10000 - pv.mate * 10 : -10000 - pv.mate * 10;
  return null;
}

function buildKeyMoment(p, kind) {
  const engineBest = engineBestFromEval(p.evalBefore, p.fenBefore);
  const swing = computeSwing(p);
  return {
    plyIndex: p.plyIndex,
    kind,
    fenBefore: p.fenBefore,
    headline: buildHeadline(p, kind, engineBest, swing),
    playedMove: { san: p.san, uci: p.uci },
    engineBest,
    evalSwing: swing,
  };
}

function engineBestFromEval(ev, fenBefore) {
  if (!ev || !ev.bestMove) return null;
  const uci = ev.bestMove;
  let san = uci;
  try {
    const board = new Chess(fenBefore);
    const m = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    if (m) san = m.san;
  } catch {
    // fall back to uci
  }
  const pv = ev.pvLines?.[0]?.moves ?? [uci];
  return { uci, san, pv };
}

function computeSwing(p) {
  const sign = p.sideToMove === "b" ? -1 : 1;
  const before = p.evalBefore.cp != null ? p.evalBefore.cp * sign : null;
  const after = p.evalAfter.cp != null ? p.evalAfter.cp * sign : null;
  if (before == null || after == null) return null;
  return after - before; // mover's POV
}

function buildHeadline(p, kind, engineBest, swing) {
  const moveStr = `${p.moveNumber}${p.sideToMove === "w" ? "." : "..."}${p.san}`;
  const matched = engineBest && p.uci === engineBest.uci;
  const swingStr = swing != null ? `${swing >= 0 ? "+" : ""}${swing} cp` : null;

  if (kind === "blunder" || kind === "mistake" || kind === "inaccuracy") {
    const parts = [moveStr, `(${kind}, ${swingStr ?? "swing n/a"})`];
    if (engineBest) parts.push(`— engine preferred ${engineBest.san}`);
    return parts.join(" ");
  }
  if (kind === "brilliant") {
    if (p.san.endsWith("#")) return `${moveStr} (brilliant — delivers mate)`;
    return `${moveStr} (brilliant${swingStr ? ", " + swingStr : ""}) — only move that wins`;
  }
  if (kind === "turning-point") {
    const tag = matched ? "critical decision, engine-best" : "critical decision";
    const parts = [moveStr, `(${tag}${swingStr ? ", " + swingStr : ""})`];
    if (!matched && engineBest) parts.push(`— engine preferred ${engineBest.san}`);
    return parts.join(" ");
  }
  return `${moveStr} (${kind})`;
}
