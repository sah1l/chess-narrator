/**
 * Render a chess position to a self-contained SVG string. No external assets,
 * no fonts to ship — pieces are Unicode glyphs styled with fill+stroke so they
 * read well on both light and dark squares.
 *
 * Inputs:
 *   fen           — FEN string. Only the placement field is used.
 *   size          — pixel size of the (square) board. Default 600.
 *   orientation   — "white" (default) or "black"
 *   highlights    — [{ square, color? }] — semi-transparent fills on squares
 *   arrows        — [{ from, to, role? }] — role one of "played" | "engine" | "neutral"
 *   showCoords    — default true
 *
 * Output: SVG markup as a string.
 */
export function renderBoardSvg({
  fen,
  size = 600,
  orientation = "white",
  highlights = [],
  arrows = [],
  showCoords = true,
} = {}) {
  if (!fen) throw new Error("renderBoardSvg: fen is required");
  const placement = fen.split(/\s+/)[0];
  const board = parsePlacement(placement);

  const sq = size / 8;
  const pieceFont = sq * 0.78;
  const coordFont = sq * 0.16;

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" font-family="'Segoe UI Symbol','Apple Symbols','Noto Sans Symbols2',sans-serif">`
  );

  // squares
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const { x, y } = toXY(f, r, orientation, sq);
      const isLight = (f + r) % 2 === 0;
      const fill = isLight ? "#f0d9b5" : "#b58863";
      parts.push(`<rect x="${x}" y="${y}" width="${sq}" height="${sq}" fill="${fill}"/>`);
    }
  }

  // highlights (rendered above squares, below pieces)
  for (const h of highlights) {
    const pos = squareToFileRank(h.square);
    if (!pos) continue;
    const { x, y } = toXY(pos.file, pos.rank, orientation, sq);
    const color = h.color ?? "#ffeb3b";
    parts.push(
      `<rect x="${x}" y="${y}" width="${sq}" height="${sq}" fill="${color}" fill-opacity="0.42"/>`
    );
  }

  // pieces
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const piece = board[r][f];
      if (!piece) continue;
      const { x, y } = toXY(f, r, orientation, sq);
      const glyph = PIECE_GLYPH[piece.toLowerCase()];
      const isWhite = piece === piece.toUpperCase();
      const fill = isWhite ? "#ffffff" : "#1a1a1a";
      const stroke = isWhite ? "#1a1a1a" : "#f5f5f5";
      const cx = x + sq / 2;
      const cy = y + sq / 2 + pieceFont * 0.34;
      parts.push(
        `<text x="${cx}" y="${cy}" font-size="${pieceFont}" text-anchor="middle" fill="${fill}" stroke="${stroke}" stroke-width="${sq * 0.022}" paint-order="stroke">${glyph}</text>`
      );
    }
  }

  // arrows (above pieces)
  for (const a of arrows) {
    const arrow = arrowSvg(a, sq, orientation);
    if (arrow) parts.push(arrow);
  }

  // coordinates (above everything, opposite-color tints)
  if (showCoords) {
    const files = orientation === "white" ? "abcdefgh" : "hgfedcba";
    const ranks = orientation === "white" ? "87654321" : "12345678";
    for (let f = 0; f < 8; f++) {
      const isLight = (f + 7) % 2 === 0;
      const color = isLight ? "#b58863" : "#f0d9b5";
      parts.push(
        `<text x="${f * sq + sq - sq * 0.08}" y="${size - sq * 0.08}" font-size="${coordFont}" text-anchor="end" fill="${color}" font-weight="600">${files[f]}</text>`
      );
    }
    for (let r = 0; r < 8; r++) {
      const isLight = r % 2 === 0;
      const color = isLight ? "#b58863" : "#f0d9b5";
      parts.push(
        `<text x="${sq * 0.08}" y="${r * sq + sq * 0.22}" font-size="${coordFont}" fill="${color}" font-weight="600">${ranks[r]}</text>`
      );
    }
  }

  parts.push("</svg>");
  return parts.join("");
}

const PIECE_GLYPH = {
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟",
};

const ARROW_COLOR = {
  played: "#1e88e5",     // blue — what was actually played
  engine: "#43a047",     // green — what the engine preferred
  neutral: "#fb8c00",    // orange — generic emphasis
  wrong: "#e53935",      // red — a tempting-but-wrong puzzle candidate
  answer: "#2faa55",     // vivid green — the puzzle's correct answer
};

function arrowSvg(arrow, sq, orientation) {
  const from = squareToFileRank(arrow.from);
  const to = squareToFileRank(arrow.to);
  if (!from || !to) return null;
  const a = toXY(from.file, from.rank, orientation, sq);
  const b = toXY(to.file, to.rank, orientation, sq);
  const ax = a.x + sq / 2;
  const ay = a.y + sq / 2;
  const bx = b.x + sq / 2;
  const by = b.y + sq / 2;

  // Shorten arrow so head doesn't overhang target square center.
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const shrink = sq * 0.22;
  const ux = dx / len;
  const uy = dy / len;
  const x2 = bx - ux * shrink;
  const y2 = by - uy * shrink;

  const color = ARROW_COLOR[arrow.role ?? "neutral"] ?? ARROW_COLOR.neutral;
  const width = sq * 0.16;
  const markerId = `arrow-${arrow.role ?? "neutral"}-${arrow.from}${arrow.to}`;

  return (
    `<defs><marker id="${markerId}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="3.2" markerHeight="3.2" orient="auto-start-reverse">` +
    `<path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker></defs>` +
    `<line x1="${ax}" y1="${ay}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round" opacity="0.85" marker-end="url(#${markerId})"/>`
  );
}

function parsePlacement(placement) {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new Error(`FEN placement must have 8 ranks (got ${ranks.length})`);
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (/\d/.test(ch)) {
        f += parseInt(ch, 10);
      } else {
        if (f > 7) throw new Error(`FEN rank ${r} overflows file`);
        board[r][f] = ch;
        f++;
      }
    }
    if (f !== 8) throw new Error(`FEN rank ${r} did not fill 8 files (got ${f})`);
  }
  return board;
}

function squareToFileRank(square) {
  if (typeof square !== "string" || !/^[a-h][1-8]$/.test(square)) return null;
  const file = square.charCodeAt(0) - "a".charCodeAt(0); // 0..7 (a..h)
  const rank = 8 - parseInt(square[1], 10);              // 0..7 (top..bottom in FEN order)
  return { file, rank };
}

function toXY(file, rank, orientation, sq) {
  // file/rank are 0..7 in FEN order (rank 0 = top, file 0 = a).
  const f = orientation === "white" ? file : 7 - file;
  const r = orientation === "white" ? rank : 7 - rank;
  return { x: f * sq, y: r * sq };
}
