import { mkdir, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { constants as FS } from "node:fs";

/**
 * ffmpeg renderer — produces an MP4 by:
 *   1. Using headless Chrome / Edge to screenshot each per-shot HTML at the
 *      configured frame resolution.
 *   2. Generating one ffmpeg segment per shot: looped image + audio (or
 *      silence) for the shot's duration.
 *   3. Concatenating all segments into the final MP4.
 *
 * Engine-line animation (walking through PV positions) is not yet wired —
 * each shot renders as a static still for its full duration. Good enough
 * for the first sharable video; animation lands in a follow-up.
 *
 * Requires:
 *   - Chrome or Edge in a standard install location (or CHROME env var set)
 *   - ffmpeg in PATH
 *
 * @param {object} args
 * @param {object} args.manifest      manifest object (from writeManifest)
 * @param {string} args.manifestDir   directory the manifest lives in
 * @param {string} args.outDir        working dir for frames + concat list
 * @param {string} args.outPath       final MP4 path
 * @param {(p: string) => void} [args.onProgress]
 */
export async function render({ manifest, manifestDir, outDir, outPath, onProgress }) {
  const chrome = await findChrome();
  const ffmpeg = await findFfmpeg();
  if (!chrome) throw new Error(CHROME_INSTRUCTIONS);
  if (!ffmpeg) throw new Error(FFMPEG_INSTRUCTIONS);

  const framesDir = path.join(outDir, "frames");
  const segmentsDir = path.join(outDir, "segments");
  await mkdir(framesDir, { recursive: true });
  await mkdir(segmentsDir, { recursive: true });

  const { width, height } = manifest.frame;

  // 1. Screenshot each shot HTML
  const frames = [];
  for (let i = 0; i < manifest.shots.length; i++) {
    const shot = manifest.shots[i];
    onProgress?.(`screenshot ${i + 1}/${manifest.shots.length}: ${shot.id}`);
    const htmlAbs = path.resolve(manifestDir, shot.htmlPath);
    const framePath = path.join(framesDir, `${shot.id}.png`);
    await screenshot(chrome, htmlAbs, framePath, width, height);
    frames.push({ shot, framePath });
  }

  // 2. Make one segment per shot
  const segmentPaths = [];
  for (let i = 0; i < frames.length; i++) {
    const { shot, framePath } = frames[i];
    onProgress?.(`encode ${i + 1}/${frames.length}: ${shot.id}`);
    const audioPath = shot.audioPath ? path.resolve(manifestDir, shot.audioPath) : null;
    const segPath = path.join(segmentsDir, `${String(i).padStart(3, "0")}-${shot.id}.mp4`);
    await encodeSegment(ffmpeg, {
      imagePath: framePath,
      audioPath,
      durationSec: shot.durationSec,
      outPath: segPath,
    });
    segmentPaths.push(segPath);
  }

  // 3. Concat
  onProgress?.("concat");
  const concatList = segmentPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join("\n");
  const concatListPath = path.join(outDir, "concat.txt");
  await writeFile(concatListPath, concatList);
  await runCmd(ffmpeg, [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", concatListPath,
    "-c", "copy",
    outPath,
  ]);

  return { outPath };
}

async function screenshot(chromeBin, htmlAbsPath, outPng, width, height) {
  const url = pathToFileURL(htmlAbsPath).toString();
  await runCmd(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-sandbox",
    `--window-size=${width},${height}`,
    `--screenshot=${outPng}`,
    url,
  ]);
}

async function encodeSegment(ffmpegBin, { imagePath, audioPath, durationSec, outPath }) {
  const args = ["-y", "-loop", "1", "-framerate", "30", "-t", String(durationSec), "-i", imagePath];
  if (audioPath) {
    args.push("-i", audioPath);
  } else {
    args.push("-f", "lavfi", "-t", String(durationSec), "-i", "anullsrc=channel_layout=mono:sample_rate=22050");
  }
  args.push(
    "-c:v", "libx264",
    "-tune", "stillimage",
    "-pix_fmt", "yuv420p",
    "-r", "30",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outPath
  );
  await runCmd(ffmpegBin, args);
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exit ${code}: ${stderr.trim().slice(-800)}`));
    });
  });
}

async function findChrome() {
  if (process.env.CHROME) {
    if (await isFile(process.env.CHROME)) return process.env.CHROME;
  }
  const platform = os.platform();
  let candidates = [];
  if (platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    candidates = [
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  } else if (platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  } else {
    candidates = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  }
  for (const c of candidates) {
    if (await isFile(c)) return c;
  }
  return null;
}

async function findFfmpeg() {
  return new Promise((resolve) => {
    const isWin = os.platform() === "win32";
    const which = isWin ? "where" : "which";
    const child = spawn(which, ["ffmpeg"]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
        resolve(first ?? "ffmpeg");
      } else {
        resolve(null);
      }
    });
  });
}

async function isFile(p) {
  try {
    await access(p, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

const CHROME_INSTRUCTIONS = `Chrome/Edge not found. The ffmpeg renderer needs a Chromium-based browser to screenshot shot HTML.

Looked in standard install paths. Set the CHROME env var to your Chrome/Edge binary, or install Chrome:
  https://www.google.com/chrome/`;

const FFMPEG_INSTRUCTIONS = `ffmpeg not found in PATH. Install it:
  Windows:  winget install ffmpeg     (or download from https://www.gyan.dev/ffmpeg/builds/)
  macOS:    brew install ffmpeg
  Linux:    apt install ffmpeg`;
