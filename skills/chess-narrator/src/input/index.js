import { readFile, stat } from "node:fs/promises";
import { parsePgn } from "./pgn.js";
import { fetchGamePgn, isChessGameUrl } from "./url.js";
import { validateFen } from "./fen.js";

/**
 * Auto-detect input form and return either a parsed game or a FEN string.
 *
 *   { kind: "game", parsed }     — for PGN text/file or URL
 *   { kind: "position", fen }    — for raw FEN
 */
export async function loadInput(input, { explicitFen = false } = {}) {
  if (explicitFen) {
    const { fen } = validateFen(input);
    return { kind: "position", fen };
  }
  if (typeof input !== "string") throw new Error("input must be a string");
  const trimmed = input.trim();

  if (/^https?:\/\//i.test(trimmed)) {
    if (!isChessGameUrl(trimmed)) {
      throw new Error(`URL not recognized as a Lichess or Chess.com game: ${trimmed}`);
    }
    const pgn = await fetchGamePgn(trimmed);
    return { kind: "game", parsed: parsePgn(pgn) };
  }

  // Path on disk?
  if (await isReadableFile(trimmed)) {
    const text = await readFile(trimmed, "utf8");
    if (looksLikePgn(text)) return { kind: "game", parsed: parsePgn(text) };
    // file but not PGN — try FEN
    if (looksLikeFen(text.trim())) {
      const { fen } = validateFen(text.trim());
      return { kind: "position", fen };
    }
    throw new Error(`File contents not recognized as PGN or FEN: ${trimmed}`);
  }

  // Inline PGN text or inline FEN?
  if (looksLikePgn(trimmed)) return { kind: "game", parsed: parsePgn(trimmed) };
  if (looksLikeFen(trimmed)) {
    const { fen } = validateFen(trimmed);
    return { kind: "position", fen };
  }

  throw new Error(
    `Could not interpret input. Expected: PGN file path, Lichess/Chess.com URL, raw FEN, or inline PGN text.\nGot: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}`
  );
}

async function isReadableFile(p) {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

function looksLikePgn(s) {
  // A real PGN starts with a tag pair "[Foo \"...\"]" or with move text "1."
  return /^\s*\[/.test(s) || /^\s*1\./.test(s);
}

function looksLikeFen(s) {
  // FEN structure: 8 ranks separated by "/" + space + active color + ...
  // Use a permissive check: must have exactly 7 slashes and an active color.
  if (s.length < 15) return false;
  const parts = s.split(/\s+/);
  if (parts.length < 2) return false;
  if (!/^[rnbqkpRNBQKP1-8]+(?:\/[rnbqkpRNBQKP1-8]+){7}$/.test(parts[0])) return false;
  if (parts[1] !== "w" && parts[1] !== "b") return false;
  return true;
}
