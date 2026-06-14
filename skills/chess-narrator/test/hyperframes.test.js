import { test } from "node:test";
import assert from "node:assert/strict";
import { planGame, squareToXY, PIECE_GLYPH } from "../src/render/hyperframes/board-dom.js";
import { buildComposition } from "../src/render/hyperframes/composition.js";
import { PIECE_SVG } from "../src/render/hyperframes/pieces.js";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// --- planGame: piece-identity tracking -------------------------------------

test("planGame assigns a stable id to every starting piece", () => {
  const { initialPieces } = planGame(START, []);
  assert.equal(initialPieces.length, 32);
  const ids = new Set(initialPieces.map((p) => p.id));
  assert.equal(ids.size, 32, "ids are unique");
  // 16 white, 16 black
  assert.equal(initialPieces.filter((p) => p.color === "w").length, 16);
});

test("planGame tracks a simple move and keeps the mover id", () => {
  const { initialPieces, moves } = planGame(START, ["e2e4", "e7e5"]);
  const e2Pawn = initialPieces.find((p) => p.square === "e2");
  assert.equal(moves.length, 2);
  assert.equal(moves[0].moverId, e2Pawn.id);
  assert.equal(moves[0].to, "e4");
  assert.equal(moves[0].capturedId, null);
});

test("planGame records the captured piece id on a capture", () => {
  // White pawn e4 takes black pawn d5.
  const fen = "k7/8/8/3p4/4P3/8/8/7K w - - 0 1";
  const { initialPieces, moves } = planGame(fen, ["e4d5"]);
  const victim = initialPieces.find((p) => p.square === "d5");
  assert.equal(moves[0].capturedId, victim.id);
});

test("planGame moves the rook on a castle", () => {
  const fen = "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1";
  const { initialPieces, moves } = planGame(fen, ["e1g1"]);
  const rook = initialPieces.find((p) => p.square === "h1");
  assert.ok(moves[0].castle, "castle info present");
  assert.equal(moves[0].castle.rookId, rook.id);
  assert.equal(moves[0].castle.from, "h1");
  assert.equal(moves[0].castle.to, "f1");
});

test("planGame records en passant capture on the right square", () => {
  // White e5 pawn captures en passant on d6; black d5 pawn is the victim.
  const fen = "k7/8/8/3pP3/8/8/8/7K w - d6 0 1";
  const { initialPieces, moves } = planGame(fen, ["e5d6"]);
  const victim = initialPieces.find((p) => p.square === "d5");
  assert.equal(moves[0].enPassantCapturedId, victim.id);
  assert.equal(moves[0].capturedId, null);
});

test("planGame records promotion type", () => {
  const fen = "8/P7/8/8/8/8/8/k6K w - - 0 1";
  const { moves } = planGame(fen, ["a7a8q"]);
  assert.equal(moves[0].promotionType, "q");
});

test("squareToXY maps a1 to bottom-left and a8 to top-left (white orientation)", () => {
  const sq = 100;
  assert.deepEqual(squareToXY("a8", sq), { x: 0, y: 0 });
  assert.deepEqual(squareToXY("a1", sq), { x: 0, y: 700 });
  assert.deepEqual(squareToXY("h1", sq), { x: 700, y: 700 });
  assert.equal(PIECE_GLYPH.k.length >= 1, true);
});

// --- buildComposition: HTML structure --------------------------------------

function sampleScript() {
  return {
    title: "Test Game",
    shots: [
      { id: "title", kind: "title", title: "Test Game", subtitle: "A vs B", durationSec: 2 },
      {
        id: "intro",
        kind: "intro",
        fen: START,
        eval: { cp: 20 },
        durationSec: 3,
        narration: "Welcome.",
        audioPath: "/tmp/audio/intro.wav",
      },
      {
        id: "move-ply00",
        kind: "move",
        pace: "silent",
        plyIndex: 0,
        fenBefore: START,
        playedMove: { san: "e4", uci: "e2e4" },
        eval: { cp: 20 },
        evalAfter: { cp: 25 },
        moveLabel: "1.e4",
        durationSec: 1.2,
        narration: null,
        audioPath: null,
      },
      {
        id: "moment-ply01",
        kind: "moment",
        pace: "full",
        plyIndex: 1,
        playedMove: { san: "e5", uci: "e7e5" },
        engineBest: { san: "c5", uci: "c7c5" },
        eval: { cp: 25 },
        evalAfter: { cp: 10 },
        moveLabel: "1...e5",
        momentKind: "mistake",
        durationSec: 8,
        narration: "A questionable choice.",
        audioPath: "/tmp/audio/moment-ply01.wav",
      },
      {
        id: "outro",
        kind: "outro",
        fen: START,
        eval: { cp: 10 },
        result: "1-0",
        durationSec: 3,
        narration: "Goodbye.",
        audioPath: "/tmp/audio/outro.wav",
      },
    ],
  };
}

test("buildComposition emits a valid composition shell with one timeline", () => {
  const { html, totalSec } = buildComposition(sampleScript());
  assert.ok(html.includes('data-composition-id="main"'));
  assert.ok(html.includes('window.__timelines["main"]'));
  assert.ok(html.includes('id="eval-fill"'));
  assert.ok(html.includes('id="board-layer"'));
  assert.equal(totalSec, 2 + 3 + 1.2 + 8 + 3);
});

test("buildComposition renders 32 pieces for the standard start", () => {
  const { html } = buildComposition(sampleScript());
  const pieceCount = (html.match(/class="pc /g) ?? []).length;
  assert.equal(pieceCount, 32);
});

test("buildComposition draws pieces as inline vector SVGs (not text glyphs)", () => {
  const { html } = buildComposition(sampleScript());
  // Every piece body is a cburnett SVG with the 0 0 45 45 viewBox — one per
  // piece on the board (32 from the standard start).
  const svgPieces = (html.match(/viewBox="0 0 45 45"/g) ?? []).length;
  assert.equal(svgPieces, 32, "32 inline piece SVGs");
  // The old flat-glyph styling is gone.
  assert.ok(!html.includes("-webkit-text-stroke"), "no text-stroke glyph styling");
  // The set covers all 12 color/type combinations.
  for (const color of ["w", "b"]) {
    for (const type of ["k", "q", "r", "b", "n", "p"]) {
      assert.ok(PIECE_SVG[color][type].includes("<svg"), `${color}${type} svg present`);
    }
  }
});

test("buildComposition clips captions and gives audio elements stable ids", () => {
  const { html, audio } = buildComposition(sampleScript());
  // Captions must be class="clip ..." so HyperFrames toggles their visibility.
  assert.ok(html.includes('class="clip cap'), "captions are clip elements");
  // One audio clip per narrated shot (intro, moment, outro) — each with an id.
  assert.equal(audio.length, 3);
  assert.ok(html.includes('<audio id="aud-1"'), "intro audio has an id");
  assert.ok(/<audio id="aud-\d+"/.test(html));
  assert.ok(audio.every((a) => a.name.startsWith("audio/")));
});

test("buildComposition animates the eval bar and draws an engine arrow on full moments", () => {
  const { html } = buildComposition(sampleScript());
  // Eval bar tween toward the post-move evaluation.
  assert.ok(html.includes('tl.to("#eval-fill"'));
  assert.ok(/scaleY:/.test(html));
  // Full moment with engineBest (c5) ≠ played (e5) → green engine arrow.
  assert.ok(html.includes("ah-engine"), "engine arrow marker present");
  // Pieces are moved by the timeline (translate deltas).
  assert.ok(/tl\.to\("#p\d+"/.test(html), "at least one piece tween");
});

test("buildComposition tolerates an empty shot list", () => {
  const { html, audio, totalSec } = buildComposition({ shots: [] });
  assert.equal(audio.length, 0);
  assert.equal(totalSec, 0);
  assert.ok(html.includes('data-composition-id="main"'));
});

test("buildComposition draws a–h / 1–8 coordinate labels", () => {
  const { html } = buildComposition(sampleScript());
  const fileLabels = (html.match(/class="coord coord-file"/g) ?? []).length;
  const rankLabels = (html.match(/class="coord coord-rank"/g) ?? []).length;
  assert.equal(fileLabels, 8);
  assert.equal(rankLabels, 8);
  assert.ok(html.includes(">a</div>") && html.includes(">h</div>"), "file letters present");
  assert.ok(html.includes(">1</div>") && html.includes(">8</div>"), "rank numbers present");
});

test("buildComposition applies the selected board theme (default green, brown swap)", () => {
  const green = buildComposition(sampleScript());
  assert.ok(green.html.includes("#769656"), "default green dark square");
  const brown = buildComposition(sampleScript(), { theme: "brown" });
  assert.ok(brown.html.includes("#b58863"), "brown dark square");
  assert.ok(!brown.html.includes("#769656"), "brown does not use green");
  // Unknown theme falls back to green.
  const fallback = buildComposition(sampleScript(), { theme: "nope" });
  assert.ok(fallback.html.includes("#769656"));
});

test("buildComposition holds the eval bar when a move has no post-move eval", () => {
  // A mate move has evalAfter:null — the bar must NOT tween (it would snap to even).
  const script = {
    title: "Mate",
    shots: [
      {
        id: "move-ply00",
        kind: "move",
        pace: "brief",
        plyIndex: 0,
        fenBefore: START,
        playedMove: { san: "e4", uci: "e2e4" },
        eval: { cp: 20 },
        evalAfter: { cp: 30 },
        moveLabel: "1.e4",
        durationSec: 2,
        narration: "x",
        audioPath: null,
      },
      {
        id: "moment-ply01",
        kind: "moment",
        pace: "full",
        plyIndex: 1,
        playedMove: { san: "Qxf7#", uci: "h5f7" },
        eval: { mate: 1 },
        evalAfter: { cp: null, mate: null },
        moveLabel: "2.Qxf7#",
        durationSec: 6,
        narration: "Checkmate.",
        audioPath: null,
      },
    ],
  };
  const { html } = buildComposition(script);
  const evalTweens = (html.match(/tl\.to\("#eval-fill"/g) ?? []).length;
  assert.equal(evalTweens, 1, "only the move with a real post-move eval tweens the bar");
});
