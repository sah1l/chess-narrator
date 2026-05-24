#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadInput } from "./input/index.js";
import { analyzeGameCached } from "./annotate/analyze.js";
import { analyzePosition } from "./input/fen.js";
import { buildNarrationPrompt } from "./narrate/prompt.js";
import { validateNarration } from "./narrate/validate.js";
import { buildShotList } from "./narrate/script.js";
import { synthesizeScript, getEngine } from "./tts/index.js";
import {
  renderPreviewHtml,
  writeManifest,
  getRenderer,
} from "./render/index.js";
import { runVerify } from "./verify.js";
import {
  assertPositiveInt,
  assertSignedInt,
  childProcesses,
} from "./utils.js";

let shuttingDown = false;
function installSignalHandlers() {
  const handle = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`\nReceived ${sig}, terminating child processes…\n`);
    for (const child of childProcesses) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
    // Give children a moment to exit cleanly, then force.
    setTimeout(() => {
      for (const child of childProcesses) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
      process.exit(130);
    }, 1500).unref();
  };
  process.on("SIGINT", () => handle("SIGINT"));
  process.on("SIGTERM", () => handle("SIGTERM"));
}

const HELP = `chess-game-explainer

Usage:
  chess-game-explainer <command> [args] [options]

Commands:
  verify                                   Check that all required tools (Node, ffmpeg, Chrome, npm deps) are installed
  analyze <input>                          Run Stockfish analysis → annotation.json
  narrate-prompt <annotation.json>         Print the prompt Claude should use to write narration
  build-script <annotation.json> <narration.json>
                                           Combine annotation + narration → shot list (script.json)
  synthesize <script.json>                 Render narration audio per shot, write enriched script
  list-voices                              List voices available to the chosen TTS engine
  render <script.audio.json>               Write preview.html + per-shot HTML + manifest, optionally compile to MP4

analyze <input> — <input> can be any of:
    - path to a PGN file              ./samples/sample-game.pgn
    - Lichess game URL                https://lichess.org/<id>
    - Chess.com game URL              https://www.chess.com/game/{live,daily}/<id>
    - raw FEN (use --fen for clarity) "rnbqkbnr/... w KQkq - 0 1"
    - inline PGN text

Options (analyze):
  --fen                   Treat <input> as a raw FEN (single-position mode)
  --depth <n>             Sweep depth for game mode (default: 10)
  --key-depth <n>         Deep re-analysis depth for key moments (default: 18)
  --position-depth <n>    Depth for single-position mode (default: 20)
  --multipv <n>           PV lines per position (default: 3)
  --opening-plies <n>     Plies treated as book when engine agrees (default: 10)
  --out <path>            Where to write annotation.json (default: samples/output/annotation.json)
  --cache-dir <path>      Cache directory (default: samples/output/.cache)
  --no-cache              Bypass the cache
  --no-challenge          Skip the "pause and think" challenge ply (annotation.challenge = null).
                          Use when you want a straight walkthrough with no puzzle interruption.

Options (narrate-prompt):
  --out <path>            Write prompt to file instead of stdout
  --format <fmt>          'text' (default) or 'json' (returns {system, user})

Options (build-script):
  --out <path>            Where to write script.json (default: samples/output/script.json)

Options (synthesize):
  --engine <name>         TTS engine: 'system' (default), 'edge', 'kokoro', 'hyperframes'
                          'edge' uses Microsoft Edge neural voices (free, requires internet
                          and ffmpeg). Sounds much closer to a live commentator than 'system'.
  --voice <name>          Engine-specific voice name (see: list-voices)
                          edge defaults to 'en-US-AndrewMultilingualNeural'.
                          Try also 'en-US-GuyNeural', 'en-US-ChristopherNeural'.
  --rate <n>              Speech rate, roughly -10..10 (engine-normalized)
  --audio-dir <path>      Where to write per-shot audio (default: samples/output/audio)
  --out <path>            Where to write enriched script (default: samples/output/script.audio.json)

Options (list-voices):
  --engine <name>         TTS engine to query (default: 'system')

Options (render):
  --out-dir <path>        Where to write render outputs (default: samples/output/render)
  --renderer <name>       Compile to MP4 with renderer: 'ffmpeg' or 'hyperframes'
                          (omit to only produce preview.html + manifest)
  --mp4 <path>            MP4 output path when --renderer is set
                          (default: samples/output/video.mp4)

Options (verify):
  --skip-network          Skip the optional network reachability check for edge-tts

Global:
  --help                  Show this message
`;

async function main(argv) {
  installSignalHandlers();
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const cmd = args[0];
  switch (cmd) {
    case "verify":
      return cmdVerify(args.slice(1));
    case "analyze":
      return cmdAnalyze(args.slice(1));
    case "narrate-prompt":
      return cmdNarratePrompt(args.slice(1));
    case "build-script":
      return cmdBuildScript(args.slice(1));
    case "synthesize":
      return cmdSynthesize(args.slice(1));
    case "list-voices":
      return cmdListVoices(args.slice(1));
    case "render":
      return cmdRender(args.slice(1));
    default:
      process.stderr.write(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

async function cmdVerify(args) {
  const { values } = parseArgs({
    args,
    options: {
      "skip-network": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  const { ok } = await runVerify({ skipNetwork: values["skip-network"] });
  process.exit(ok ? 0 : 1);
}

async function cmdAnalyze(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      fen: { type: "boolean" },
      depth: { type: "string" },
      "key-depth": { type: "string" },
      "position-depth": { type: "string" },
      multipv: { type: "string" },
      "opening-plies": { type: "string" },
      out: { type: "string" },
      "cache-dir": { type: "string" },
      "no-cache": { type: "boolean" },
      "no-challenge": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  if (positionals.length === 0) {
    process.stderr.write("analyze: missing <input>\n");
    process.exit(1);
  }

  const input = positionals[0];
  const sweepDepth = assertPositiveInt("--depth", values.depth, 10);
  const keyMomentDepth = assertPositiveInt("--key-depth", values["key-depth"], 18);
  const positionDepth = assertPositiveInt("--position-depth", values["position-depth"], 20);
  const multiPV = assertPositiveInt("--multipv", values.multipv, 3);
  const openingPlies = assertPositiveInt("--opening-plies", values["opening-plies"], 10);
  const outPath = path.resolve(values.out ?? "samples/output/annotation.json");
  const cacheDir = path.resolve(values["cache-dir"] ?? "samples/output/.cache");

  const t0 = Date.now();
  log(`Loading input: ${truncate(input, 80)}`);
  const loaded = await loadInput(input, { explicitFen: values.fen });

  let annotation;
  let fromCache = false;
  if (loaded.kind === "position") {
    log(`Mode: position (FEN). Running depth-${positionDepth} analysis...`);
    annotation = await analyzePosition(loaded.fen, { depth: positionDepth, multiPV });
  } else {
    const parsed = loaded.parsed;
    log(`Mode: game. Parsed ${parsed.plies.length} plies.`);
    log(
      `Players: ${parsed.headers.White ?? "?"} vs ${parsed.headers.Black ?? "?"} — result ${parsed.result}`
    );
    const onProgress = ({ ply, total, phase }) => {
      if (ply % 5 === 0 || ply === total - 1) {
        process.stderr.write(`\r[${phase}] ${ply + 1}/${total}   `);
      }
    };
    const res = await analyzeGameCached(
      parsed,
      {
        sweepDepth,
        keyMomentDepth,
        multiPV,
        openingPlies,
        onProgress,
        noChallenge: values["no-challenge"],
      },
      values["no-cache"] ? path.join(cacheDir, "__nocache__") : cacheDir
    );
    annotation = res.annotation;
    fromCache = res.fromCache;
    process.stderr.write("\n");
  }

  await writeFile(outPath, JSON.stringify(annotation, null, 2));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(
    `${fromCache ? "Loaded from cache" : "Analyzed"} in ${elapsed}s — wrote ${outPath}`
  );
  log(`Key moments (${annotation.keyMoments.length}):`);
  for (const km of annotation.keyMoments) {
    const where = km.plyIndex >= 0 ? `ply ${km.plyIndex} ` : "";
    log(`  ${where}[${km.kind}] ${km.headline}`);
  }
}

async function cmdNarratePrompt(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      format: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  if (positionals.length === 0) {
    process.stderr.write("narrate-prompt: missing <annotation.json>\n");
    process.exit(1);
  }
  const annotationPath = path.resolve(positionals[0]);
  const annotation = JSON.parse(await readFile(annotationPath, "utf8"));
  const { system, user } = buildNarrationPrompt(annotation);

  const format = values.format ?? "text";
  let output;
  if (format === "json") {
    output = JSON.stringify({ system, user }, null, 2);
  } else if (format === "text") {
    output =
      `===== SYSTEM PROMPT =====\n${system}\n\n` +
      `===== USER MESSAGE =====\n${user}\n`;
  } else {
    process.stderr.write(`Unknown --format: ${format} (expected 'text' or 'json')\n`);
    process.exit(1);
  }

  if (values.out) {
    const outPath = path.resolve(values.out);
    await writeFile(outPath, output);
    log(`Wrote prompt to ${outPath}`);
  } else {
    process.stdout.write(output);
  }
}

async function cmdBuildScript(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  if (positionals.length < 2) {
    process.stderr.write("build-script: requires <annotation.json> <narration.json>\n");
    process.exit(1);
  }
  const annotationPath = path.resolve(positionals[0]);
  const narrationPath = path.resolve(positionals[1]);
  const outPath = path.resolve(values.out ?? "samples/output/script.json");

  const annotation = JSON.parse(await readFile(annotationPath, "utf8"));
  const narration = JSON.parse(await readFile(narrationPath, "utf8"));

  const { valid, errors } = validateNarration(narration, annotation);
  if (!valid) {
    process.stderr.write(`Narration validation failed:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }

  const script = buildShotList(annotation, narration);
  await writeFile(outPath, JSON.stringify(script, null, 2));
  log(
    `Wrote script with ${script.shots.length} shots (${script.totalSeconds.toFixed(1)}s total) → ${outPath}`
  );
  for (const sh of script.shots) {
    log(`  [${sh.kind}] ${sh.durationSec}s  ${truncate(sh.narration ?? sh.title ?? "", 70)}`);
  }
}

async function cmdSynthesize(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      engine: { type: "string" },
      voice: { type: "string" },
      rate: { type: "string" },
      "audio-dir": { type: "string" },
      out: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  if (positionals.length === 0) {
    process.stderr.write("synthesize: missing <script.json>\n");
    process.exit(1);
  }
  const scriptPath = path.resolve(positionals[0]);
  const audioDir = path.resolve(values["audio-dir"] ?? "samples/output/audio");
  const outPath = path.resolve(values.out ?? "samples/output/script.audio.json");

  const script = JSON.parse(await readFile(scriptPath, "utf8"));
  const engineName = values.engine ?? "system";
  const rate = assertSignedInt("--rate", values.rate, undefined);

  log(`Synthesizing with engine=${engineName}${values.voice ? `, voice=${values.voice}` : ""} → ${audioDir}`);
  const t0 = Date.now();
  const enriched = await synthesizeScript(script, {
    engine: engineName,
    voice: values.voice,
    rate,
    outDir: audioDir,
    onProgress: ({ shotId, i, total }) => {
      process.stderr.write(`\r[tts] ${i}/${total}  ${shotId}                `);
    },
  });
  process.stderr.write("\n");
  await writeFile(outPath, JSON.stringify(enriched, null, 2));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`Wrote enriched script with ${enriched.shots.length} shots (${enriched.totalSeconds}s actual) in ${elapsed}s → ${outPath}`);
  for (const sh of enriched.shots) {
    const audioInfo = sh.audioPath ? `${sh.durationSec}s (est ${sh.estimatedDurationSec}s)` : `${sh.durationSec}s (no audio)`;
    log(`  [${sh.kind}] ${audioInfo}  ${truncate(sh.narration ?? sh.title ?? "", 60)}`);
  }
}

async function cmdRender(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "out-dir": { type: "string" },
      renderer: { type: "string" },
      mp4: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return process.stdout.write(HELP);
  if (positionals.length === 0) {
    process.stderr.write("render: missing <script.audio.json>\n");
    process.exit(1);
  }
  const scriptPath = path.resolve(positionals[0]);
  const outDir = path.resolve(values["out-dir"] ?? "samples/output/render");
  const mp4Path = path.resolve(values.mp4 ?? "samples/output/video.mp4");

  const script = JSON.parse(await readFile(scriptPath, "utf8"));

  log(`Writing per-shot HTML + manifest → ${outDir}`);
  const { manifestPath, manifest } = await writeManifest(script, outDir);
  log(`  manifest: ${manifestPath}`);

  const previewPath = path.join(outDir, "preview.html");
  const previewHtml = renderPreviewHtml(script, { previewDir: outDir });
  await writeFile(previewPath, previewHtml);
  log(`  preview:  ${previewPath}`);
  log(`Open the preview in your browser to watch the explainer end-to-end.`);

  if (values.renderer) {
    log(`\nCompiling MP4 with renderer=${values.renderer}...`);
    const renderer = getRenderer(values.renderer);
    const workDir = path.join(outDir, ".render-work");
    const t0 = Date.now();
    const result = await renderer.render({
      manifest,
      manifestDir: outDir,
      outDir: workDir,
      outPath: mp4Path,
      onProgress: (msg) => process.stderr.write(`\r[render] ${msg}                    `),
    });
    process.stderr.write("\n");
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    log(`Wrote MP4 in ${elapsed}s → ${result?.outPath ?? mp4Path}`);
  }
}

async function cmdListVoices(args) {
  const { values } = parseArgs({
    args,
    options: { engine: { type: "string" }, help: { type: "boolean" } },
  });
  if (values.help) return process.stdout.write(HELP);
  const engine = getEngine(values.engine ?? "system");
  const voices = await engine.listVoices();
  if (voices.length === 0) {
    log("(no voices found)");
    return;
  }
  for (const v of voices) log(v);
}

function log(msg) {
  process.stdout.write(msg + "\n");
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

main(process.argv).catch((e) => {
  process.stderr.write(`\nFAILED: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
