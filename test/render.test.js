import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBoardSvg } from "../src/render/board.js";
import { renderShotPage, renderShotBody, FRAME_WIDTH, FRAME_HEIGHT } from "../src/render/templates.js";
import { renderPreviewHtml } from "../src/render/preview.js";
import { writeManifest } from "../src/render/manifest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TMP = path.join(__dirname, "_render_tmp");

async function loadJson(p) {
  return JSON.parse(await readFile(path.join(ROOT, p), "utf8"));
}

test("renderBoardSvg produces an 8x8 grid for the starting position", () => {
  const svg = renderBoardSvg({
    fen: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
  });
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.endsWith("</svg>"));
  // 64 squares
  const rectCount = (svg.match(/<rect /g) ?? []).length;
  // 64 board squares + any highlight rects (none here)
  assert.equal(rectCount, 64);
  // 32 pieces in starting position, each rendered as one <text>
  const textCount = (svg.match(/<text /g) ?? []).length;
  // 32 pieces + 8 file labels + 8 rank labels
  assert.equal(textCount, 32 + 16);
});

test("renderBoardSvg respects orientation", () => {
  const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const white = renderBoardSvg({ fen, orientation: "white" });
  const black = renderBoardSvg({ fen, orientation: "black" });
  // they should differ in piece coordinates (white has K at e1=bottom; black flips)
  assert.notEqual(white, black);
});

test("renderBoardSvg draws arrows and highlights", () => {
  const svg = renderBoardSvg({
    fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
    arrows: [{ from: "e2", to: "e4", role: "played" }],
    highlights: [{ square: "e4" }],
  });
  assert.ok(svg.includes("<line"), "should include arrow line");
  assert.ok(svg.includes("marker-end"), "should reference arrow marker");
  assert.ok(svg.includes("fill-opacity=\"0.42\""), "highlight should be translucent");
});

test("renderBoardSvg throws on malformed FEN", () => {
  assert.throws(() => renderBoardSvg({ fen: "garbage" }), /placement must have 8 ranks/);
});

test("renderShotPage emits a standalone HTML document", () => {
  const html = renderShotPage(
    { id: "title", kind: "title", title: "Test", subtitle: "sub", durationSec: 4, narration: null },
    { title: "Test" }
  );
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes(`width: ${FRAME_WIDTH}px`));
  assert.ok(html.includes(`height: ${FRAME_HEIGHT}px`));
  assert.ok(html.includes("Test"));
});

test("renderShotBody handles every shot kind in the sample script", async () => {
  const script = await loadJson("samples/output/script.audio.json");
  const ctx = { title: script.title };
  for (const shot of script.shots) {
    const body = renderShotBody(shot, ctx);
    assert.ok(body.includes("<section class=\"shot"));
    if (shot.kind === "moment" || shot.kind === "move") {
      assert.ok(body.includes("info-move"), `${shot.kind} shot ${shot.id} should have a move label`);
    }
    if (shot.kind === "moment") {
      assert.ok(body.includes("class=\"tag"), `moment ${shot.id} should have a tag`);
    }
  }
});

test("renderShotBody renders challenge shots with the right markers", async () => {
  const script = await loadJson("samples/output/script.audio.json");
  const ctx = { title: script.title };
  const prompt = script.shots.find((s) => s.kind === "challenge-prompt");
  const think = script.shots.find((s) => s.kind === "challenge-think");
  const cand = script.shots.find((s) => s.kind === "challenge-candidate");
  const reveal = script.shots.find((s) => s.kind === "challenge-reveal");
  if (!prompt) return; // sample may have no challenge in degenerate cases
  assert.ok(renderShotBody(prompt, ctx).includes("Pause"), "prompt should say Pause");
  assert.ok(renderShotBody(think, ctx).includes("Thinking"), "think should say Thinking");
  assert.ok(renderShotBody(cand, ctx).includes("Why not"), "candidate should say Why not");
  assert.ok(renderShotBody(cand, ctx).includes("tag-wrong"), "candidate should have a wrong tag");
  assert.ok(renderShotBody(reveal, ctx).includes("tag-answer"), "reveal should have an answer tag");
});

test("renderShotBody marks book moves with a 'Book' tag in move shots", async () => {
  const script = await loadJson("samples/output/script.audio.json");
  const ctx = { title: script.title };
  const bookShot = script.shots.find((s) => s.kind === "move" && s.isBookMove);
  if (!bookShot) return; // sample may not have book moves in degenerate cases
  const body = renderShotBody(bookShot, ctx);
  assert.ok(body.includes("tag-book"), "book moves should render with a Book tag");
});

test("renderShotBody escapes user text to avoid HTML injection", () => {
  const shot = {
    id: "x", kind: "title",
    title: "<script>alert('x')</script>",
    subtitle: null,
    durationSec: 4,
    narration: null,
  };
  const body = renderShotBody(shot, {});
  assert.ok(!body.includes("<script>alert"), "raw <script> tag must be escaped");
  assert.ok(body.includes("&lt;script&gt;"));
});

test("renderPreviewHtml inlines all shots with audio elements", async () => {
  const script = await loadJson("samples/output/script.audio.json");
  const html = renderPreviewHtml(script, { previewDir: path.join(ROOT, "samples/output/render") });
  assert.ok(html.includes("<!doctype html>"));
  // one slide per shot
  const slideCount = (html.match(/class="slide"/g) ?? []).length;
  assert.equal(slideCount, script.shots.length);
  // audio elements only for shots with narration
  const audioCount = (html.match(/<audio /g) ?? []).length;
  const expectedAudio = script.shots.filter((s) => s.audioPath).length;
  assert.equal(audioCount, expectedAudio);
  // controller wiring
  assert.ok(html.includes("id=\"btn-play\""));
  assert.ok(html.includes("id=\"progress-bar\""));
});

test("renderPreviewHtml uses paths relative to previewDir for audio", async () => {
  const script = await loadJson("samples/output/script.audio.json");
  const previewDir = path.join(ROOT, "samples/output/render");
  const html = renderPreviewHtml(script, { previewDir });
  // The audio paths should be relative (no drive letter)
  assert.ok(!/src="[A-Z]:[/\\]/.test(html), "audio src must not be absolute");
  // And they should resolve to ../audio/*.wav
  assert.ok(html.includes("../audio/intro.wav"), "expected relative audio path");
});

test("writeManifest emits per-shot HTML + manifest.json with relative paths", async () => {
  await rm(TMP, { recursive: true, force: true });
  const script = await loadJson("samples/output/script.audio.json");
  const { manifestPath, manifest } = await writeManifest(script, TMP);

  // manifest.json exists
  const raw = await readFile(manifestPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.title, script.title);
  assert.equal(parsed.shots.length, script.shots.length);
  // htmlPath is relative (no drive letter)
  for (const sh of parsed.shots) {
    assert.ok(!/^[A-Z]:[/\\]/.test(sh.htmlPath), `${sh.id} htmlPath should be relative`);
    assert.ok(sh.htmlPath.startsWith("shots/"), `${sh.id} should live under shots/`);
    if (sh.audioPath) {
      assert.ok(!/^[A-Z]:[/\\]/.test(sh.audioPath), `${sh.id} audioPath should be relative`);
    }
  }
  // each per-shot html file exists and parses as a doc
  for (const sh of manifest.shots) {
    const html = await readFile(path.join(TMP, sh.htmlPath), "utf8");
    assert.ok(html.startsWith("<!doctype html>"));
  }
});

test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});
