import { Chess } from "chess.js";

/**
 * Boil a full annotation down to a compact briefing object that's small enough
 * to fit comfortably in a prompt without losing the information Claude needs
 * to write good guided-walkthrough narration.
 *
 * In the new format, the briefing is move-centric: one entry per ply, with
 * just enough engine context to write tiered commentary (book / routine /
 * interesting / critical). Drops PV-line details for routine moves and only
 * surfaces the engine's preferred alternative when it actually matters
 * (inaccuracies, mistakes, blunders, brilliancies).
 *
 * @param {object} annotation  raw annotation JSON (game or position mode)
 * @returns {object} compact briefing object
 */
export function buildBriefing(annotation) {
  if (annotation.mode === "position") {
    return briefingForPosition(annotation);
  }
  return briefingForGame(annotation);
}

const SHOW_ENGINE_ALT_FOR = new Set([
  "inaccuracy",
  "mistake",
  "blunder",
  "brilliant",
  "turning-point",
]);

function briefingForGame(annotation) {
  const h = annotation.headers ?? {};
  const keyMomentByPly = new Map(
    (annotation.keyMoments ?? []).map((km) => [km.plyIndex, km])
  );

  const moves = annotation.plies.map((ply) =>
    briefingForMove(ply, keyMomentByPly.get(ply.plyIndex), annotation)
  );

  return {
    mode: "game",
    white: h.White ?? "White",
    black: h.Black ?? "Black",
    event: h.Event ?? null,
    site: h.Site ?? null,
    date: h.Date ?? null,
    opening: h.Opening ?? null,
    eco: h.ECO ?? null,
    result: annotation.result ?? "*",
    totalPlies: annotation.plies.length,
    finalEval: describeEval(lastEval(annotation.plies)),
    summary: gameSummary(annotation),
    moves,
    challenge: briefingForChallenge(annotation),
  };
}

/**
 * Surface the analyzer's challenge pick so the prompt can ask Claude to
 * write puzzle content. Returns null if the game has no challenge.
 */
function briefingForChallenge(annotation) {
  const ch = annotation.challenge;
  if (!ch) return null;
  const ply = annotation.plies[ch.plyIndex];
  if (!ply) return null;
  const mover = ply.sideToMove === "w" ? "White" : "Black";
  const moveStr = `${ply.moveNumber}${ply.sideToMove === "w" ? "." : "..."}${ply.san}`;
  return {
    plyIndex: ch.plyIndex,
    moveStr,
    mover,
    fenBefore: ply.fenBefore,
    answer: {
      san: ply.san,
      uci: ply.uci,
    },
    candidates: ch.candidates.map((c) => ({
      rank: c.rank,
      san: c.san,
      uci: c.uci,
      isBest: c.isBest,
      evalText: c.mate != null
        ? (c.mate > 0 ? `mate in ${c.mate}` : `mated in ${-c.mate}`)
        : (c.cp != null ? `${(c.cp / 100).toFixed(2)} cp` : "n/a"),
      pvSan: c.pvSan ?? [],
    })),
  };
}

function briefingForPosition(annotation) {
  const km = annotation.keyMoments[0] ?? null;
  return {
    mode: "position",
    fen: km?.fenBefore ?? null,
    headline: km?.headline ?? null,
    engineBest: km?.engineBest
      ? {
          san: km.engineBest.san,
          uci: km.engineBest.uci,
          pvSan: uciPvToSan(km.fenBefore, km.engineBest.pv, 6),
        }
      : null,
  };
}

/**
 * Tier label used in the prompt so Claude knows how deep to go.
 *
 *   book        — opening theory move (1 short sentence)
 *   routine     — best/good, non-book (1-2 sentences with the idea)
 *   interesting — best/good but a clear engine alternative existed worth a mention (2-3 sentences)
 *   critical    — inaccuracy / mistake / blunder / brilliant / turning-point (full coach treatment)
 *
 * Mapping rules:
 *   - isBookMove → book
 *   - classification in {inaccuracy, mistake, blunder} → critical
 *   - is a key moment (brilliant / turning-point / forced narrative) → critical
 *   - best/good with engine alternative gap and not matching engine → interesting
 *   - otherwise → routine
 */
function tierFor(ply, km) {
  if (km) return "critical"; // selected as a key moment by the analyzer
  if (ply.isBookMove) return "book";
  const c = ply.classification;
  if (c === "inaccuracy" || c === "mistake" || c === "blunder") return "critical";
  // best/good but engine disagreed → interesting
  if ((c === "best" || c === "good") && ply.evalBefore?.bestMove && ply.uci !== ply.evalBefore.bestMove) {
    return "interesting";
  }
  return "routine";
}

function briefingForMove(ply, km, annotation) {
  const tier = tierFor(ply, km);
  const mover = ply.sideToMove === "w" ? "White" : "Black";
  const moveStr = `${ply.moveNumber}${ply.sideToMove === "w" ? "." : "..."}${ply.san}`;

  const engineBestUci = ply.evalBefore?.bestMove ?? null;
  const playedMatchesEngine =
    engineBestUci != null && engineBestUci === ply.uci;

  // Only compute an engine alternative SAN + line for tiers where it adds value.
  let engineAlt = null;
  if (!playedMatchesEngine && SHOW_ENGINE_ALT_FOR.has(km?.kind ?? ply.classification)) {
    if (km?.engineBest) {
      engineAlt = {
        san: km.engineBest.san,
        uci: km.engineBest.uci,
        pvSan: uciPvToSan(ply.fenBefore, km.engineBest.pv, 4),
      };
    } else if (engineBestUci) {
      const san = uciToSan(ply.fenBefore, engineBestUci);
      engineAlt = san ? { san, uci: engineBestUci, pvSan: [san] } : null;
    }
  }

  return {
    plyIndex: ply.plyIndex,
    moveNumber: ply.moveNumber,
    mover,
    moveStr,
    san: ply.san,
    uci: ply.uci,
    tier,
    classification: ply.classification,
    isBookMove: ply.isBookMove,
    isCheck: ply.san.includes("+"),
    isMate: ply.san.endsWith("#"),
    isCapture: ply.san.includes("x"),
    centipawnLoss: ply.centipawnLoss ?? 0,
    evalBefore: describeEval(ply.evalBefore),
    evalAfter: describeEval(ply.evalAfter),
    evalBeforeCp: scalarCp(ply.evalBefore),
    evalAfterCp: scalarCp(ply.evalAfter),
    swingCp: swingFromPly(ply),
    engineAlt,
    keyMomentKind: km?.kind ?? null,
    headline: km?.headline ?? null,
  };
}

/**
 * A short paragraph summarizing the whole game so the intro/outro can land
 * the narrative arc without forcing Claude to scan all moves.
 */
function gameSummary(annotation) {
  const counts = countByTier(annotation);
  const kmKinds = (annotation.keyMoments ?? []).map((km) => km.kind);
  return {
    bookPlies: counts.book,
    routinePlies: counts.routine,
    inaccuracies: counts.inaccuracy,
    mistakes: counts.mistake,
    blunders: counts.blunder,
    brilliancies: kmKinds.filter((k) => k === "brilliant").length,
    turningPoints: kmKinds.filter((k) => k === "turning-point").length,
    result: annotation.result,
  };
}

function countByTier(annotation) {
  const c = { book: 0, routine: 0, inaccuracy: 0, mistake: 0, blunder: 0 };
  for (const p of annotation.plies) {
    if (p.isBookMove) c.book += 1;
    else if (p.classification === "inaccuracy") c.inaccuracy += 1;
    else if (p.classification === "mistake") c.mistake += 1;
    else if (p.classification === "blunder") c.blunder += 1;
    else c.routine += 1;
  }
  return c;
}

function lastEval(plies) {
  for (let i = plies.length - 1; i >= 0; i--) {
    const e = plies[i].evalAfter ?? plies[i].evalBefore;
    if (e) return e;
  }
  return null;
}

function describeEval(ev) {
  if (!ev) return "n/a";
  if (ev.mate != null) {
    if (ev.mate === 0) return "checkmated";
    return ev.mate > 0 ? `White mates in ${ev.mate}` : `Black mates in ${-ev.mate}`;
  }
  if (ev.cp != null) {
    const v = (ev.cp / 100).toFixed(2);
    if (ev.cp >= 50) return `White +${v}`;
    if (ev.cp <= -50) return `Black +${Math.abs(v).toFixed ? Math.abs(v).toFixed(2) : Math.abs(v)}`;
    return `roughly equal (${v})`;
  }
  return "n/a";
}

function scalarCp(ev) {
  if (!ev) return null;
  if (ev.mate != null) return ev.mate > 0 ? 10000 : -10000;
  return ev.cp ?? null;
}

function swingFromPly(ply) {
  const before = scalarCp(ply.evalBefore);
  const after = scalarCp(ply.evalAfter);
  if (before == null || after == null) return null;
  const sign = ply.sideToMove === "b" ? -1 : 1;
  return (after - before) * sign;
}

function uciPvToSan(fen, uciPv, maxPlies = 6) {
  if (!fen || !Array.isArray(uciPv)) return [];
  const board = new Chess(fen);
  const out = [];
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

function uciToSan(fen, uci) {
  if (!fen || !uci) return null;
  try {
    const board = new Chess(fen);
    const m = board.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return m?.san ?? null;
  } catch {
    return null;
  }
}
