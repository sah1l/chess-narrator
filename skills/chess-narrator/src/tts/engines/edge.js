import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { escapeXml, trackChild } from "../../utils.js";

/**
 * Edge-TTS adapter — uses Microsoft Edge's neural voices via the public
 * "Read Aloud" WebSocket endpoint (no API key, but requires internet).
 *
 * Why this exists: SAPI 5 sounds robotic. Edge's neural voices like
 * `en-US-AndrewMultilingualNeural` produce broadcaster-quality narration
 * that feels much closer to a live chess commentator.
 *
 * The library only emits MP3/Opus, so we synth to MP3 then convert to
 * 16-bit PCM mono WAV with ffmpeg (already required by the video stage).
 *
 * The WebSocket client is reused across calls in the same process to skip
 * per-shot reconnect overhead — the Opera Game has 30+ segments and a
 * fresh handshake every time would dominate runtime.
 *
 * Options:
 *   voice  — Edge voice short-name (default: en-US-AndrewMultilingualNeural)
 *   rate   — generic -10..10 scale; mapped to SSML prosody rate % (each
 *            step ≈ 5%, clamped to ±50%). 0/undefined = default speed.
 */

const DEFAULT_VOICE = "en-US-AndrewMultilingualNeural";
const OUTPUT_FORMAT_USED = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

let ttsInstance = null;
let ttsVoice = null;

async function getTts(voice) {
  if (ttsInstance && ttsVoice === voice) return ttsInstance;
  if (ttsInstance) {
    try { ttsInstance.close(); } catch { /* ignore */ }
  }
  ttsInstance = new MsEdgeTTS();
  await ttsInstance.setMetadata(voice, OUTPUT_FORMAT_USED, {});
  ttsVoice = voice;
  return ttsInstance;
}

export async function synthesize({ text, outPath, voice, rate }) {
  if (!text || !text.trim()) {
    throw new Error("edge engine: empty text");
  }
  const v = voice ?? DEFAULT_VOICE;
  const tts = await getTts(v);

  const opts = {};
  if (rate != null && rate !== 0) {
    const pct = Math.max(-50, Math.min(50, Math.round(rate * 5)));
    opts.rate = pct >= 0 ? `+${pct}%` : `${pct}%`;
  }

  // msedge-tts wraps text inside <prosody> in an SSML doc, so we escape
  // XML special chars in the narration to avoid breaking the parser.
  const safeText = escapeXml(text);

  await mkdir(path.dirname(outPath), { recursive: true });
  const tmpMp3 = outPath.replace(/\.wav$/i, "") + ".tmp.mp3";

  try {
    const { audioStream } = tts.toStream(safeText, opts);
    await streamToFile(audioStream, tmpMp3);
    await mp3ToWav(tmpMp3, outPath);
  } finally {
    await unlink(tmpMp3).catch(() => {});
  }
}

export async function listVoices() {
  const tts = new MsEdgeTTS();
  try {
    const voices = await tts.getVoices();
    return voices
      .map((v) => v.ShortName)
      .filter(Boolean)
      .sort();
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}

function streamToFile(readable, filePath) {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(filePath);
    let settled = false;
    const fail = (e) => {
      if (settled) return;
      settled = true;
      out.destroy();
      reject(e);
    };
    readable.on("error", fail);
    out.on("error", fail);
    out.on("finish", () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    readable.pipe(out);
  });
}

function mp3ToWav(mp3Path, wavPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-loglevel", "error",
      "-i", mp3Path,
      "-acodec", "pcm_s16le",
      "-ar", "22050",
      "-ac", "1",
      wavPath,
    ];
    const ff = trackChild(spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] }));
    let err = "";
    ff.stderr.on("data", (d) => (err += d.toString()));
    ff.on("error", (e) => {
      if (e.code === "ENOENT") {
        reject(new Error("ffmpeg not found on PATH — edge engine needs it to convert mp3 → wav"));
      } else reject(e);
    });
    ff.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${err.trim().slice(-400)}`));
    });
  });
}

