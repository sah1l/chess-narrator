import { Chess } from "chess.js";

/**
 * Board animation planner for the continuous (HyperFrames) renderer.
 *
 * The still renderer draws one static SVG per shot. The continuous renderer
 * instead keeps ONE board on screen and slides pieces from square to square.
 * To animate a slide we need stable identities for the physical pieces so a
 * GSAP timeline can tween the same DOM element across many moves — chess.js
 * gives us legal-move semantics (capture / castle / en passant / promotion
 * flags) but not piece identity, so we track that ourselves.
 *
 * planGame(startFen, ucis) replays the game and returns:
 *   - initialPieces: every piece on the starting board, each with a stable id,
 *     so the composition can emit one positioned DOM element per piece.
 *   - moves: one entry per UCI (aligned 1:1, in order) describing what the
 *     renderer must animate — which id slides from→to, which id is captured
 *     (faded out), the rook hop on a castle, and any promotion.
 *
 * Geometry (square → pixel) lives in the composition; this module is purely
 * logical so it can be unit-tested without a DOM.
 */

export const PIECE_GLYPH = {
  k: "♚", // ♚
  q: "♛", // ♛
  r: "♜", // ♜
  b: "♝", // ♝
  n: "♞", // ♞
  p: "♟", // ♟
};

/**
 * @param {string} startFen  FEN of the position the game starts from
 * @param {string[]} ucis    played moves in order (e2e4, e7e5, e1g1, e7e8q, …)
 * @returns {{ initialPieces: object[], moves: (object|null)[], finalFen: string }}
 */
export function planGame(startFen, ucis) {
  const chess = new Chess(startFen);

  // Assign a stable id to every piece on the starting board. chess.board()
  // returns rank 8 first; the square field gives algebraic coordinates.
  const initialPieces = [];
  const squareToId = new Map();
  let counter = 0;
  for (const row of chess.board()) {
    for (const cell of row) {
      if (!cell) continue;
      const id = `p${counter++}`;
      initialPieces.push({ id, type: cell.type, color: cell.color, square: cell.square });
      squareToId.set(cell.square, id);
    }
  }

  const moves = [];
  for (let i = 0; i < ucis.length; i++) {
    const uci = ucis[i];
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4].toLowerCase() : undefined;

    let mv;
    try {
      mv = chess.move({ from, to, promotion });
    } catch {
      mv = null;
    }
    if (!mv) {
      // Illegal/unparseable move — skip the slide but keep alignment.
      moves.push(null);
      continue;
    }

    const moverId = squareToId.get(from) ?? null;
    const flags = mv.flags ?? "";
    let capturedId = null;
    let enPassantCapturedId = null;
    let castle = null;

    if (flags.includes("e")) {
      // En passant: the captured pawn sits on the destination file but the
      // mover's starting rank, not on `to`.
      const epSquare = to[0] + from[1];
      enPassantCapturedId = squareToId.get(epSquare) ?? null;
      squareToId.delete(epSquare);
    } else if (mv.captured) {
      // Normal capture: the victim is the piece currently on `to`.
      capturedId = squareToId.get(to) ?? null;
    }

    // Advance the mover. set() on `to` overwrites any captured id in the map.
    squareToId.delete(from);
    squareToId.set(to, moverId);

    if (flags.includes("k") || flags.includes("q")) {
      const rank = from[1];
      const rookFrom = flags.includes("k") ? `h${rank}` : `a${rank}`;
      const rookTo = flags.includes("k") ? `f${rank}` : `d${rank}`;
      const rookId = squareToId.get(rookFrom) ?? null;
      squareToId.delete(rookFrom);
      squareToId.set(rookTo, rookId);
      castle = { rookId, from: rookFrom, to: rookTo };
    }

    moves.push({
      index: i,
      moverId,
      color: mv.color, // 'w' | 'b'
      from,
      to,
      capturedId,
      enPassantCapturedId,
      castle,
      promotionType: mv.promotion ?? null, // 'q' | 'r' | 'b' | 'n' | null
    });
  }

  return { initialPieces, moves, finalFen: chess.fen() };
}

/**
 * Parse an algebraic square ("e4") into 0-based file/rank where rank 0 is the
 * top of the board in white orientation (FEN order). Returns null if invalid.
 */
export function squareToFileRank(square) {
  if (typeof square !== "string" || !/^[a-h][1-8]$/.test(square)) return null;
  const file = square.charCodeAt(0) - "a".charCodeAt(0); // 0..7 (a..h)
  const rank = 8 - parseInt(square[1], 10); // 0..7 (top..bottom)
  return { file, rank };
}

/**
 * Top-left pixel of a square, given square size and orientation. Mirrors the
 * still renderer's geometry so both renderers agree on board layout.
 */
export function squareToXY(square, sq, orientation = "white") {
  const fr = squareToFileRank(square);
  if (!fr) return null;
  const f = orientation === "white" ? fr.file : 7 - fr.file;
  const r = orientation === "white" ? fr.rank : 7 - fr.rank;
  return { x: f * sq, y: r * sq };
}

/** Center pixel of a square — used for arrow endpoints. */
export function squareCenter(square, sq, orientation = "white") {
  const xy = squareToXY(square, sq, orientation);
  if (!xy) return null;
  return { x: xy.x + sq / 2, y: xy.y + sq / 2 };
}
