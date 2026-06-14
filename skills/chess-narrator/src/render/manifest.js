import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderShotPage, FRAME_WIDTH, FRAME_HEIGHT } from "./templates.js";
import { slugifyId, toForwardSlash } from "../utils.js";

/**
 * Write one HTML file per shot plus a manifest.json describing the timeline.
 * The manifest is the contract that HyperFrames, ffmpeg, or any other
 * downstream renderer consumes.
 *
 * Output layout (relative to outDir):
 *   shots/title.html
 *   shots/intro.html
 *   shots/<moment-id>.html
 *   shots/outro.html
 *   manifest.json
 *
 * Paths in manifest.json are relative to outDir so the manifest is portable.
 *
 * @param {object} script   enriched script (from synthesizeScript)
 * @param {string} outDir   directory to write per-shot HTML + manifest
 * @returns {Promise<{manifestPath: string, manifest: object}>}
 */
export async function writeManifest(script, outDir) {
  const shotsDir = path.join(outDir, "shots");
  await mkdir(shotsDir, { recursive: true });

  const ctx = { title: script.title };
  const shotEntries = [];

  for (const shot of script.shots) {
    const html = renderShotPage(shot, ctx);
    const safeId = slugifyId(shot.id);
    const htmlPath = path.join(shotsDir, `${safeId}.html`);
    await writeFile(htmlPath, html);
    shotEntries.push({
      id: shot.id,
      kind: shot.kind,
      htmlPath: toForwardSlash(path.relative(outDir, htmlPath)),
      audioPath: shot.audioPath
        ? toForwardSlash(path.relative(outDir, shot.audioPath))
        : null,
      durationSec: shot.durationSec,
      estimatedDurationSec: shot.estimatedDurationSec ?? null,
    });
  }

  const manifest = {
    schemaVersion: "1.0.0",
    title: script.title,
    subtitle: script.subtitle ?? null,
    totalSeconds: round2(script.totalSeconds ?? shotEntries.reduce((s, sh) => s + sh.durationSec, 0)),
    frame: { width: FRAME_WIDTH, height: FRAME_HEIGHT, fps: 30 },
    audio: script.audio
      ? {
          engine: script.audio.engine,
          voice: script.audio.voice,
          rate: script.audio.rate,
          outDir: script.audio.outDir
            ? toForwardSlash(path.relative(outDir, script.audio.outDir))
            : null,
        }
      : null,
    shots: shotEntries,
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return { manifestPath, manifest };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
