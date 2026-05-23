import { mkdir } from "node:fs/promises";
import path from "node:path";
import { getEngine, DEFAULT_ENGINE } from "./index.js";
import { readWavDuration } from "./duration.js";

/**
 * Take a script (from buildShotList) and synthesize one audio file per shot
 * that has narration. Replaces the estimated `durationSec` with the actual
 * measured audio duration. Returns the enriched script.
 *
 * @param {object} script  shot list produced by buildShotList
 * @param {object} opts
 * @param {string} [opts.engine="system"]   TTS adapter name
 * @param {string} opts.outDir              directory to write audio files
 * @param {string} [opts.voice]             engine-specific voice name
 * @param {number} [opts.rate]              speech rate (engine-normalized)
 * @param {(p: {shotId: string, i: number, total: number}) => void} [opts.onProgress]
 * @returns {Promise<object>} enriched script (new shots[] with audioPath +
 *                            measured durationSec)
 */
export async function synthesizeScript(script, opts) {
  const {
    engine: engineName = DEFAULT_ENGINE,
    outDir,
    voice,
    rate,
    onProgress,
  } = opts ?? {};
  if (!outDir) throw new Error("synthesizeScript: outDir is required");

  await mkdir(outDir, { recursive: true });
  const engine = getEngine(engineName);

  const shotsWithNarration = script.shots.filter((s) => s.narration);
  const newShots = [];
  let i = 0;
  for (const shot of script.shots) {
    if (!shot.narration) {
      newShots.push({ ...shot, audioPath: null });
      continue;
    }
    const audioPath = path.join(outDir, `${shot.id}.wav`);
    onProgress?.({ shotId: shot.id, i: i + 1, total: shotsWithNarration.length });
    await engine.synthesize({
      text: shot.narration,
      outPath: audioPath,
      voice,
      rate,
    });
    const actualDuration = await readWavDuration(audioPath);
    newShots.push({
      ...shot,
      audioPath,
      estimatedDurationSec: shot.durationSec,
      durationSec: round2(actualDuration),
    });
    i++;
  }

  const totalSeconds = newShots.reduce((s, sh) => s + sh.durationSec, 0);
  return {
    ...script,
    shots: newShots,
    totalSeconds: round2(totalSeconds),
    audio: {
      engine: engineName,
      voice: voice ?? null,
      rate: rate ?? null,
      outDir,
    },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
