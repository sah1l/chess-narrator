import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNarration } from "../src/narrate/validate.js";
import { buildShotList } from "../src/narrate/script.js";
import { buildNarrationPrompt } from "../src/narrate/prompt.js";
import { buildBriefing } from "../src/narrate/summary.js";
import { pickChallenge } from "../src/annotate/challenge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

async function loadJson(p) {
  return JSON.parse(await readFile(path.join(ROOT, p), "utf8"));
}

test("validateNarration accepts the sample narration", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const { valid, errors } = validateNarration(narration, annotation);
  assert.equal(valid, true, `expected valid, got errors: ${errors.join("; ")}`);
});

test("validateNarration rejects missing schemaVersion", () => {
  const { valid, errors } = validateNarration({
    title: "Test",
    intro: { text: "hi", estimatedSeconds: 5 },
    segments: [{ plyIndex: 0, text: "x", estimatedSeconds: 5 }],
    outro: { text: "bye", estimatedSeconds: 5 },
  });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /schemaVersion/.test(e)));
});

test("validateNarration rejects mismatched challenge.plyIndex", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const broken = {
    ...narration,
    challenge: { ...narration.challenge, plyIndex: narration.challenge.plyIndex + 2 },
  };
  const { valid, errors } = validateNarration(broken, annotation);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /challenge\.plyIndex mismatch/.test(e)));
});

test("validateNarration requires challenge when annotation has one", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const stripped = { ...narration, challenge: null };
  const { valid, errors } = validateNarration(stripped, annotation);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /narration\.challenge is null/.test(e)));
});

test("validateNarration rejects segment with out-of-range estimatedSeconds", () => {
  const narration = {
    schemaVersion: "1.2.0",
    title: "Test game",
    intro: { text: "hi", estimatedSeconds: 5 },
    segments: [{ plyIndex: 0, text: "x", estimatedSeconds: 90 }],
    outro: { text: "bye", estimatedSeconds: 5 },
  };
  const { valid, errors } = validateNarration(narration);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /estimatedSeconds/.test(e)));
});

test("validateNarration rejects invalid highlightSquares", () => {
  const narration = {
    schemaVersion: "1.2.0",
    title: "Test game",
    intro: { text: "hi", estimatedSeconds: 5 },
    segments: [
      { plyIndex: 0, text: "x", estimatedSeconds: 5, highlightSquares: ["z9"] },
    ],
    outro: { text: "bye", estimatedSeconds: 5 },
  };
  const { valid, errors } = validateNarration(narration);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /highlightSquares/.test(e)));
});

test("validateNarration rejects unknown depth value", () => {
  const narration = {
    schemaVersion: "1.2.0",
    title: "Test game",
    intro: { text: "hi", estimatedSeconds: 5 },
    segments: [
      { plyIndex: 0, text: "x", estimatedSeconds: 5, depth: "exhaustive" },
    ],
    outro: { text: "bye", estimatedSeconds: 5 },
  };
  const { valid, errors } = validateNarration(narration);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /depth/.test(e)));
});

test("validateNarration rejects segment count != ply count", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  // drop one segment
  const broken = { ...narration, segments: narration.segments.slice(0, -1) };
  const { valid, errors } = validateNarration(broken, annotation);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /segment count/.test(e)));
});

test("validateNarration rejects mismatched plyIndex order", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const reordered = {
    ...narration,
    segments: [...narration.segments].reverse(),
  };
  const { valid, errors } = validateNarration(reordered, annotation);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => /plyIndex/.test(e)));
});

test("buildShotList produces title + intro + per-ply shots + challenge expansion + outro", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const script = buildShotList(annotation, narration);
  const challengeShots = narration.challenge ? (1 + 1 + narration.challenge.candidates.length + 1) - 1 : 0;
  // For each challenge ply, we add N extra shots (challenge expansion adds 4 shots and removes the 1 normal ply shot).
  const expected = 1 + 1 + annotation.plies.length + challengeShots + 1;
  assert.equal(script.shots.length, expected);
  assert.equal(script.shots[0].kind, "title");
  assert.equal(script.shots[1].kind, "intro");
  assert.equal(script.shots[script.shots.length - 1].kind, "outro");
});

test("buildShotList replaces challenge ply with prompt/think/candidates/reveal sequence", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const script = buildShotList(annotation, narration);
  const cPly = narration.challenge.plyIndex;

  // The challenge ply should NOT have a normal move/moment shot — only challenge-* kinds.
  const cplyShots = script.shots.filter((s) => s.plyIndex === cPly);
  for (const s of cplyShots) {
    assert.ok(s.kind.startsWith("challenge-"), `expected challenge-*, got ${s.kind}`);
  }

  // Expect the sequence: prompt, think, candidate*, reveal — in order.
  const kinds = cplyShots.map((s) => s.kind);
  assert.equal(kinds[0], "challenge-prompt");
  assert.equal(kinds[1], "challenge-think");
  assert.equal(kinds[kinds.length - 1], "challenge-reveal");
  for (let i = 2; i < kinds.length - 1; i++) {
    assert.equal(kinds[i], "challenge-candidate");
  }
  // think shot has no narration (silent pause)
  const think = cplyShots[1];
  assert.equal(think.narration, null);
  // reveal carries the answer move + a green "answer" arrow
  const reveal = cplyShots[cplyShots.length - 1];
  assert.equal(reveal.answer.san, annotation.plies[cPly].san);
  assert.equal(reveal.arrows[0].role, "answer");
  // candidates each carry a "wrong" arrow
  for (let i = 2; i < kinds.length - 1; i++) {
    assert.equal(cplyShots[i].arrows[0].role, "wrong");
  }
});

test("buildShotList uses 'moment' kind for critical plies and 'move' for routine", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const script = buildShotList(annotation, narration);

  // Opera Game key moments at non-challenge plies: 11 (mistake), 17 (inaccuracy), 18 (turning-point), 32 (brilliant)
  // Ply 30 is consumed by the challenge sequence so it has no 'moment' shot.
  const momentPlies = script.shots.filter((s) => s.kind === "moment").map((s) => s.plyIndex);
  for (const p of [11, 17, 18, 32]) {
    assert.ok(momentPlies.includes(p), `ply ${p} should be a moment shot`);
  }

  // First few plies are book moves and should use the compact "move" kind.
  const ply0 = script.shots.find((s) => s.plyIndex === 0);
  assert.equal(ply0.kind, "move");
  assert.equal(ply0.isBookMove, true);
});

test("buildShotList arrows: engine arrow only on moments where engine differs from played", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const script = buildShotList(annotation, narration);

  // ply 11 = mistake (Nf6, engine wanted Qf6) — should have both played + engine arrows
  const mistake = script.shots.find((s) => s.plyIndex === 11);
  assert.equal(mistake.kind, "moment");
  const roles = mistake.arrows.map((a) => a.role).sort();
  assert.deepEqual(roles, ["engine", "played"]);

  // ply 0 = book (e4) — should have only the played arrow
  const book = script.shots.find((s) => s.plyIndex === 0);
  assert.equal(book.arrows.length, 1);
  assert.equal(book.arrows[0].role, "played");

  // ply 18 = brilliant 10.Nxb5 — engine MATCHES played, so only played arrow
  const brilliant = script.shots.find((s) => s.plyIndex === 18);
  assert.equal(brilliant.kind, "moment");
  assert.equal(brilliant.arrows.length, 1, "engine matched played, no engine arrow");
});


test("buildShotList totalSeconds equals sum of shot durations", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const narration = await loadJson("samples/sample-narration.json");
  const script = buildShotList(annotation, narration);
  const sum = script.shots.reduce((s, sh) => s + sh.durationSec, 0);
  assert.equal(script.totalSeconds, sum);
});

test("buildBriefing exposes one entry per ply with tier and engine alt for critical moves", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const briefing = buildBriefing(annotation);
  assert.equal(briefing.moves.length, annotation.plies.length);

  // ply 11 = mistake, should be tier=critical with engine alt provided
  const mistake = briefing.moves.find((m) => m.plyIndex === 11);
  assert.equal(mistake.tier, "critical");
  assert.ok(mistake.engineAlt, "critical move should have engineAlt");
  assert.equal(mistake.engineAlt.san, "Qf6");

  // ply 0 = book, should be tier=book and no engine alt
  const book = briefing.moves.find((m) => m.plyIndex === 0);
  assert.equal(book.tier, "book");
  assert.equal(book.engineAlt, null);
});

test("buildBriefing summary counts game shape", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const briefing = buildBriefing(annotation);
  assert.ok(briefing.summary);
  assert.ok(briefing.summary.bookPlies > 0);
  assert.equal(typeof briefing.summary.mistakes, "number");
});

test("pickChallenge picks a brilliant key moment where played equals engine best", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const challenge = pickChallenge(annotation.plies, annotation.keyMoments);
  assert.ok(challenge, "Opera Game should have a challenge");
  const ply = annotation.plies[challenge.plyIndex];
  // Must not be the mate-delivery move itself
  assert.ok(!ply.san.endsWith("#"), "challenge ply should not be mate-in-1");
  // Played move must equal engine best
  assert.equal(ply.uci, ply.evalBefore.bestMove);
  // Multiple candidates
  assert.ok(challenge.candidates.length >= 2);
  // First candidate is the answer (= engine best)
  assert.equal(challenge.candidates[0].isBest, true);
  assert.equal(challenge.candidates[0].uci, ply.uci);
});

test("pickChallenge returns null when no qualifying moment exists", () => {
  // No key moments → no challenge.
  const result = pickChallenge([], []);
  assert.equal(result, null);
});

test("buildNarrationPrompt renders briefing with every move and tier annotations", async () => {
  const annotation = await loadJson("samples/output/annotation.json");
  const { system, user, briefing } = buildNarrationPrompt(annotation);
  assert.ok(system.includes("guided walkthrough"));
  assert.ok(user.includes("Paul Morphy"));
  // every ply should appear in the briefing
  assert.ok(user.includes("[ply 0]"));
  assert.ok(user.includes("[ply 11]"));
  assert.ok(user.includes("[ply 32]"));
  // tier tags are visible
  assert.ok(user.includes("tier=book"));
  assert.ok(user.includes("tier=critical"));
  assert.equal(briefing.moves.length, annotation.plies.length);
});
