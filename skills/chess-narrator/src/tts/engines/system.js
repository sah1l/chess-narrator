import { spawn } from "node:child_process";
import os from "node:os";

/**
 * System TTS adapter — uses whatever the OS provides.
 *   Windows: SAPI 5 via PowerShell + System.Speech
 *   macOS:   `say --data-format=LEI16@22050 -o <out> <text>`
 *   Linux:   `espeak -w <out> <text>`
 *
 * All produce a 16-bit PCM WAV. Quality is "good enough for drafting" —
 * upgrade to Kokoro or HyperFrames for production.
 *
 * Options:
 *   voice  — engine-specific voice name (e.g., "Microsoft Zira Desktop")
 *   rate   — speech rate, normalized to roughly -10..10 (Windows SAPI scale).
 *
 * Returns a Promise that resolves when synthesis is complete. Throws with
 * actionable error text on failure (missing espeak, unknown voice, etc.).
 */
export async function synthesize({ text, outPath, voice, rate }) {
  const platform = os.platform();
  if (platform === "win32") return synthesizeWindows({ text, outPath, voice, rate });
  if (platform === "darwin") return synthesizeMac({ text, outPath, voice, rate });
  if (platform === "linux") return synthesizeLinux({ text, outPath, voice, rate });
  throw new Error(`system TTS adapter does not support platform: ${platform}`);
}

export async function listVoices() {
  const platform = os.platform();
  if (platform === "win32") return listVoicesWindows();
  if (platform === "darwin") return listVoicesMac();
  if (platform === "linux") return listVoicesLinux();
  return [];
}

// ---------- Windows (SAPI 5) ----------

const PS_SYNTH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$text = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Speech | Out-Null
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:CGE_TTS_RATE -ne $null -and $env:CGE_TTS_RATE -ne '') {
  $synth.Rate = [int]$env:CGE_TTS_RATE
}
if ($env:CGE_TTS_VOICE -ne $null -and $env:CGE_TTS_VOICE -ne '') {
  $synth.SelectVoice($env:CGE_TTS_VOICE)
}
$synth.SetOutputToWaveFile($env:CGE_TTS_OUT)
$synth.Speak($text)
$synth.Dispose()
`;

const PS_LIST_VOICES = `
Add-Type -AssemblyName System.Speech | Out-Null
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name } | Sort-Object
$s.Dispose()
`;

function runPowerShell(script, { env = {}, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, ...env } }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`PowerShell exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (stdin != null) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}

async function synthesizeWindows({ text, outPath, voice, rate }) {
  const env = { CGE_TTS_OUT: outPath };
  if (voice) env.CGE_TTS_VOICE = voice;
  if (rate != null) env.CGE_TTS_RATE = String(rate);
  await runPowerShell(PS_SYNTH_SCRIPT, { env, stdin: text });
}

async function listVoicesWindows() {
  const out = await runPowerShell(PS_LIST_VOICES);
  return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

// ---------- macOS (`say`) ----------

function runCmd(cmd, args, { stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exit ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

async function synthesizeMac({ text, outPath, voice, rate }) {
  const args = ["--data-format=LEI16@22050", "-o", outPath];
  if (voice) args.push("-v", voice);
  // `say -r` is words/minute; sensible range 150-300.
  if (rate != null) args.push("-r", String(150 + rate * 15));
  args.push(text);
  await runCmd("say", args);
}

async function listVoicesMac() {
  try {
    const out = await runCmd("say", ["-v", "?"]);
    return out
      .split(/\r?\n/)
      .map((line) => line.split(/\s{2,}/)[0]?.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ---------- Linux (espeak / espeak-ng) ----------

async function synthesizeLinux({ text, outPath, voice, rate }) {
  const args = ["-w", outPath];
  if (voice) args.push("-v", voice);
  if (rate != null) args.push("-s", String(175 + rate * 15));
  args.push(text);
  // Try espeak-ng first (modern), fall back to espeak.
  try {
    await runCmd("espeak-ng", args);
  } catch (e) {
    if (e.code === "ENOENT" || /ENOENT/.test(e.message)) {
      await runCmd("espeak", args);
    } else {
      throw e;
    }
  }
}

async function listVoicesLinux() {
  for (const bin of ["espeak-ng", "espeak"]) {
    try {
      const out = await runCmd(bin, ["--voices"]);
      return out
        .split(/\r?\n/)
        .slice(1)
        .map((line) => line.split(/\s+/)[4])
        .filter(Boolean);
    } catch {
      // try next
    }
  }
  return [];
}
