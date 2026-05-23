import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { platform } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (color, s) => (useColor ? `${color}${s}${RESET}` : s);

/**
 * Verify the runtime environment. Prints a per-check status table.
 * Returns { ok: boolean, results: [...] }; exits 1 from CLI when ok=false.
 */
export async function runVerify({ skipNetwork = false } = {}) {
  const checks = [
    { name: "Node ≥22", required: true, run: checkNode },
    { name: "stockfish (npm)", required: true, run: checkStockfish },
    { name: "chess.js (npm)", required: true, run: checkChessJs },
    { name: "msedge-tts (npm)", required: false, run: checkEdgeTtsPkg },
    { name: "ffmpeg on PATH", required: true, run: checkFfmpeg },
    { name: "Chrome/Edge/Chromium", required: true, run: checkBrowser },
  ];
  if (!skipNetwork) {
    checks.push({ name: "edge-tts reachable", required: false, run: checkEdgeTtsNetwork });
  }

  process.stdout.write("chess-narrator environment check\n\n");
  const results = [];
  for (const ch of checks) {
    let res;
    try {
      res = await ch.run();
    } catch (err) {
      res = { ok: false, detail: err.message };
    }
    results.push({ ...ch, ...res });
    printRow(ch, res);
  }

  const missingRequired = results.filter((r) => r.required && !r.ok);
  process.stdout.write("\n");
  if (missingRequired.length === 0) {
    process.stdout.write(c(GREEN, "All required dependencies present.") + "\n");
    process.stdout.write(c(DIM, "Try: node src/cli.js analyze samples/sample-game.pgn") + "\n");
    return { ok: true, results };
  }
  process.stdout.write(
    c(RED, `${missingRequired.length} required dependency missing.`) +
      " See install hints above.\n"
  );
  return { ok: false, results };
}

function printRow(check, res) {
  const tag = res.ok ? c(GREEN, "[OK]  ") : check.required ? c(RED, "[MISS]") : c(YELLOW, "[WARN]");
  const name = check.name.padEnd(24);
  const detail = res.detail ? c(DIM, ` — ${res.detail}`) : "";
  process.stdout.write(`  ${tag} ${name}${detail}\n`);
  if (!res.ok && res.hint) {
    process.stdout.write(`         ${c(DIM, "↳ " + res.hint)}\n`);
  }
}

async function checkNode() {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 22) return { ok: true, detail: `v${process.versions.node}` };
  return {
    ok: false,
    detail: `v${process.versions.node}`,
    hint: "Install Node 22+ from https://nodejs.org or nvm: nvm install 22",
  };
}

async function checkStockfish() {
  try {
    const resolved = require.resolve("stockfish");
    return { ok: true, detail: shortPath(resolved) };
  } catch {
    return { ok: false, hint: "Run: npm install" };
  }
}

async function checkChessJs() {
  try {
    const resolved = require.resolve("chess.js");
    return { ok: true, detail: shortPath(resolved) };
  } catch {
    return { ok: false, hint: "Run: npm install" };
  }
}

async function checkEdgeTtsPkg() {
  try {
    require.resolve("msedge-tts");
    return { ok: true };
  } catch {
    return { ok: false, hint: "Only needed for --engine edge. Run: npm install" };
  }
}

async function checkFfmpeg() {
  const path = await whichBin("ffmpeg");
  if (path) {
    const ver = await firstLine([path, "-version"]);
    return { ok: true, detail: ver ? trimVersion(ver) : shortPath(path) };
  }
  return {
    ok: false,
    hint: hintFor("ffmpeg"),
  };
}

async function checkBrowser() {
  const candidates =
    platform() === "win32"
      ? ["chrome", "chromium", "msedge"]
      : ["google-chrome", "chrome", "chromium", "chromium-browser", "msedge"];
  for (const name of candidates) {
    const p = await whichBin(name);
    if (p) return { ok: true, detail: `${name} → ${shortPath(p)}` };
  }
  // Well-known install locations
  const fallbacks = platform() === "win32" ? winBrowserFallbacks() : macBrowserFallbacks();
  for (const p of fallbacks) {
    if (await fileExists(p)) return { ok: true, detail: shortPath(p) };
  }
  return {
    ok: false,
    hint:
      platform() === "win32"
        ? "Install Chrome (winget install Google.Chrome) or rely on Edge."
        : platform() === "darwin"
          ? "Install via: brew install --cask google-chrome"
          : "Install via: apt install chromium  (or google-chrome-stable)",
  };
}

async function checkEdgeTtsNetwork() {
  // edge-tts uses a Microsoft WebSocket endpoint; a TCP connect is enough to know we can reach it.
  const host = "speech.platform.bing.com";
  try {
    const net = await import("node:net");
    await new Promise((resolve, reject) => {
      const sock = net.connect({ host, port: 443, timeout: 3000 }, () => {
        sock.end();
        resolve();
      });
      sock.on("error", reject);
      sock.on("timeout", () => {
        sock.destroy();
        reject(new Error("timeout"));
      });
    });
    return { ok: true, detail: host };
  } catch (err) {
    return {
      ok: false,
      hint: `Cannot reach ${host}:443 (${err.message}). Only needed for --engine edge.`,
    };
  }
}

function winBrowserFallbacks() {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pfx86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const lad = process.env["LOCALAPPDATA"] ?? "";
  return [
    `${pf}\\Google\\Chrome\\Application\\chrome.exe`,
    `${pfx86}\\Google\\Chrome\\Application\\chrome.exe`,
    lad ? `${lad}\\Google\\Chrome\\Application\\chrome.exe` : "",
    `${pf}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${pfx86}\\Microsoft\\Edge\\Application\\msedge.exe`,
  ].filter(Boolean);
}

function macBrowserFallbacks() {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
}

function hintFor(tool) {
  if (platform() === "win32") {
    return `Install ${tool}: winget install Gyan.FFmpeg  (or scoop install ${tool})`;
  }
  if (platform() === "darwin") {
    return `Install ${tool}: brew install ${tool}`;
  }
  return `Install ${tool}: apt install ${tool}  (or yum/dnf install ${tool})`;
}

async function whichBin(name) {
  const cmd = platform() === "win32" ? "where" : "which";
  return new Promise((resolve) => {
    const child = spawn(cmd, [name], { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 && out.trim()) resolve(out.split(/\r?\n/)[0].trim());
      else resolve(null);
    });
  });
}

async function firstLine([cmd, ...args]) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d.toString();
      if (out.includes("\n")) {
        child.kill();
      }
    });
    child.on("error", () => resolve(null));
    child.on("close", () => resolve(out.split(/\r?\n/)[0]?.trim() ?? null));
  });
}

function trimVersion(line) {
  // "ffmpeg version 6.1.1 Copyright ..." → "ffmpeg version 6.1.1"
  const m = line.match(/^(\S+ version \S+)/);
  return m ? m[1] : line.slice(0, 60);
}

async function fileExists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function shortPath(p) {
  if (!p) return "";
  if (p.length <= 60) return p;
  return "…" + p.slice(p.length - 59);
}
