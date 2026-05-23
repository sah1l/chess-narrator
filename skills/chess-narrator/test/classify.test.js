import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyMove,
  classifyTerminal,
  centipawnLoss,
  evalToCp,
  CLASSIFICATION,
} from "../src/annotate/classify.js";

test("evalToCp flips score for Black mover", () => {
  assert.equal(evalToCp({ cp: 100, mate: null }, "w"), 100);
  assert.equal(evalToCp({ cp: 100, mate: null }, "b"), -100);
});

test("evalToCp converts mate scores to large centipawn values", () => {
  // mate in 3 from White's POV is ~9970cp from White's POV.
  const v = evalToCp({ cp: null, mate: 3 }, "w");
  assert.ok(v > 9000, `expected mate-in-3 to be ~9970, got ${v}`);
  assert.ok(v < 10000);
  // From Black's POV the same eval is very negative.
  const vb = evalToCp({ cp: null, mate: 3 }, "b");
  assert.ok(vb < -9000);
});

test("centipawnLoss is positive when the mover gave up advantage", () => {
  // White was +200, after move White is -50 → mover (White) lost 250cp.
  const loss = centipawnLoss(
    { cp: 200, mate: null },
    { cp: -50, mate: null },
    "w"
  );
  assert.equal(loss, 250);
});

test("centipawnLoss handles Black mover correctly", () => {
  // Black at +100 (i.e., White at -100 → Black is up 100).
  // After move, White at -50 → Black is up 50. Black gave up 50.
  const loss = centipawnLoss(
    { cp: -100, mate: null },
    { cp: -50, mate: null },
    "b"
  );
  assert.equal(loss, 50);
});

test("classifyMove: matching engine best returns BEST regardless of loss bucket", () => {
  const r = classifyMove({
    evalBefore: { cp: 50, mate: null },
    evalAfter: { cp: -100, mate: null }, // loss of 150 in mover POV
    playedUci: "e2e4",
    bestUci: "e2e4",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BEST);
});

test("classifyMove: thresholds 50/100/300 produce inaccuracy/mistake/blunder", () => {
  const mk = (loss) =>
    classifyMove({
      evalBefore: { cp: loss, mate: null },
      evalAfter: { cp: 0, mate: null },
      playedUci: "a",
      bestUci: "b",
      mover: "w",
    });
  assert.equal(mk(30).classification, CLASSIFICATION.GOOD);
  assert.equal(mk(60).classification, CLASSIFICATION.INACCURACY);
  assert.equal(mk(150).classification, CLASSIFICATION.MISTAKE);
  assert.equal(mk(400).classification, CLASSIFICATION.BLUNDER);
});

test("classifyMove: already-lost mover does not get further blamed", () => {
  // White was already -600cp; played a non-engine move that drops to -900.
  const r = classifyMove({
    evalBefore: { cp: -600, mate: null },
    evalAfter: { cp: -900, mate: null },
    playedUci: "a",
    bestUci: "b",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.FORCED);
  assert.equal(r.centipawnLoss, 0);
});

test("classifyMove: book move stays BOOK", () => {
  const r = classifyMove({
    evalBefore: { cp: 0, mate: null },
    evalAfter: { cp: -50, mate: null },
    playedUci: "a",
    bestUci: "b",
    mover: "w",
    isBookMove: true,
  });
  assert.equal(r.classification, CLASSIFICATION.BOOK);
});

test("classifyMove: blowing a forced mate is a blunder", () => {
  // White had mate-in-2; played a non-best move and lost the mate.
  const r = classifyMove({
    evalBefore: { cp: null, mate: 2 },
    evalAfter: { cp: 50, mate: null }, // no more mate, just slight edge
    playedUci: "a",
    bestUci: "b",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BLUNDER);
});

test("classifyMove: slower mate (still winning) is GOOD, not blunder", () => {
  const r = classifyMove({
    evalBefore: { cp: null, mate: 2 },
    evalAfter: { cp: null, mate: 5 },
    playedUci: "a",
    bestUci: "b",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.GOOD);
  assert.equal(r.centipawnLoss, 0);
});

test("classifyTerminal: delivering checkmate is BEST", () => {
  const r = classifyTerminal({
    evalBefore: { cp: null, mate: 1 },
    terminal: "checkmate",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BEST);
  assert.equal(r.centipawnLoss, 0);
});

test("classifyTerminal: stalemate when winning is a blunder", () => {
  const r = classifyTerminal({
    evalBefore: { cp: 800, mate: null },
    terminal: "stalemate",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BLUNDER);
});

test("classifyTerminal: stalemate when losing is BEST (saves the half-point)", () => {
  const r = classifyTerminal({
    evalBefore: { cp: -800, mate: null },
    terminal: "stalemate",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BEST);
});

test("centipawn loss is capped to classification bucket", () => {
  // huge loss but matched engine → should be classified BEST with loss <= 10
  const r = classifyMove({
    evalBefore: { cp: 500, mate: null },
    evalAfter: { cp: -2000, mate: null },
    playedUci: "x",
    bestUci: "x",
    mover: "w",
  });
  assert.equal(r.classification, CLASSIFICATION.BEST);
  assert.ok(r.centipawnLoss <= 10, `expected loss <= 10, got ${r.centipawnLoss}`);
});
