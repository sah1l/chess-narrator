import { readFile } from "node:fs/promises";
import { Chess } from "chess.js";

/**
 * Load and normalize a PGN game.
 *
 * @param {string} pgnText - The raw PGN text.
 * @returns {{headers: object, result: string, plies: PlyInput[]}}
 *
 * PlyInput is the pre-evaluation shape of a half-move. The engine driver
 * fills in eval data afterwards.
 */
export function parsePgn(pgnText) {
  const chess = new Chess();
  const ok = chess.loadPgn(pgnText, { strict: false });
  if (!ok && ok !== undefined) {
    throw new Error("Failed to parse PGN");
  }

  const rawHeaders = chess.header();
  const headers = Object.fromEntries(
    Object.entries(rawHeaders).filter(([, v]) => v != null && v !== "")
  );
  const result = normalizeResult(headers.Result);
  const history = chess.history({ verbose: true });

  const plies = [];
  const replay = new Chess();
  for (let i = 0; i < history.length; i++) {
    const move = history[i];
    const fenBefore = replay.fen();
    const result = replay.move(move.san);
    if (!result) {
      throw new Error(`Replay diverged at ply ${i}: ${move.san}`);
    }
    plies.push({
      plyIndex: i,
      moveNumber: Math.floor(i / 2) + 1,
      sideToMove: i % 2 === 0 ? "w" : "b",
      san: move.san,
      uci: move.from + move.to + (move.promotion ?? ""),
      fenBefore,
      fenAfter: replay.fen(),
    });
  }

  return { headers, result, plies };
}

export async function parsePgnFile(path) {
  const text = await readFile(path, "utf8");
  return parsePgn(text);
}

function normalizeResult(raw) {
  if (!raw) return "*";
  const r = raw.trim();
  if (r === "1-0" || r === "0-1" || r === "1/2-1/2" || r === "*") return r;
  return "*";
}
