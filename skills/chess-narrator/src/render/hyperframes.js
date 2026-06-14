import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { trackChild } from "../utils.js";
import { buildComposition } from "./hyperframes/composition.js";

/**
 * HyperFrames renderer — produces a continuous animated MP4.
 *
 * Unlike the ffmpeg renderer (one frozen still per shot), this builds a single
 * HyperFrames composition where the pieces slide move-to-move and the eval bar
 * animates live, then renders it deterministically frame-by-frame:
 *
 *   1. buildComposition(script) → a self-contained index.html (board + eval bar
 *      + captions + a GSAP timeline) plus the list of per-shot audio clips.
 *   2. Write index.html into a project dir and copy each audio WAV next to it.
 *   3. `npx hyperframes render <projDir> --output <mp4> --fps 30` seeks the
 *      composition at every frame, screenshots it, and muxes the audio.
 *
 * Requires the HyperFrames CLI, fetched on first use via npx (needs network)
 * unless already cached. ffmpeg + a Chromium browser are pulled in by the CLI.
 *
 * @param {object} args
 * @param {object} args.script        enriched shot list (script.audio.json)
 * @param {string} args.outDir        project/work dir for the composition
 * @param {string} args.outPath       final MP4 path
 * @param {number} [args.fps=30]
 * @param {string} [args.theme]       board color theme (green|brown|blue)
 * @param {(p: string) => void} [args.onProgress]
 */
export async function render({ script, outDir, outPath, fps = 30, theme, onProgress }) {
  if (!script || !Array.isArray(script.shots)) {
    throw new Error(
      "hyperframes renderer needs the enriched script (script.audio.json) with a shots[] array"
    );
  }

  const projDir = outDir;
  const audioDir = path.join(projDir, "audio");
  await mkdir(audioDir, { recursive: true });
  await mkdir(path.dirname(outPath), { recursive: true });

  onProgress?.("building composition");
  const { html, audio, totalSec } = buildComposition(script, { theme });
  await writeFile(path.join(projDir, "index.html"), html);

  // Copy each per-shot WAV next to the composition so the <audio src> paths
  // ("audio/<name>") resolve locally and the render is self-contained.
  for (const a of audio) {
    await copyFile(a.src, path.join(projDir, a.name));
  }

  onProgress?.(`rendering ${totalSec.toFixed(1)}s @ ${fps}fps via hyperframes`);
  await runHyperframes(projDir, outPath, fps, onProgress);
  return { outPath, totalSec };
}

export const HF_VERSION = process.env.HYPERFRAMES_VERSION || "0.6.97";

function runHyperframes(projDir, outPath, fps, onProgress) {
  return new Promise((resolve, reject) => {
    // .cmd shims must run through a shell on Windows (Node refuses to spawn
    // them directly), so use shell:true with a quoted command on every OS.
    const cmd =
      `npx --yes hyperframes@${HF_VERSION} render ${q(projDir)} ` +
      `--output ${q(outPath)} --fps ${fps} --quiet`;
    const child = trackChild(spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] }));
    let tail = "";
    const onData = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      // Surface the CLI's own progress lines (frame counts, phases).
      const line = s.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
      if (line) onProgress?.(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (e) =>
      reject(new Error(`${HYPERFRAMES_INSTRUCTIONS}\n\nUnderlying error: ${e.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hyperframes render exit ${code}:\n${tail.trim().slice(-1200)}`));
    });
  });
}

/** Quote a path for a shell command (handles spaces on Windows + POSIX). */
function q(p) {
  return `"${String(p).replace(/"/g, '\\"')}"`;
}

/** Best-effort check that the HyperFrames CLI is reachable (used by verify). */
export function isAvailable() {
  return new Promise((resolve) => {
    const cmd = `npx --yes hyperframes@${HF_VERSION} --version`;
    const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => resolve({ ok: code === 0, version: out.trim() || null }));
  });
}

export const HYPERFRAMES_INSTRUCTIONS = `HyperFrames CLI not reachable. The continuous renderer shells out to:
  npx hyperframes@${HF_VERSION} render ...
which is fetched from npm on first use (needs internet) and then cached. It also pulls a Chromium browser + ffmpeg on first run.

If you have no network, render with the still renderer instead:
  node src/cli.js render <script.audio.json> --renderer ffmpeg`;
