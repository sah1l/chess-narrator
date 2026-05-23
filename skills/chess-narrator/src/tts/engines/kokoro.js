/**
 * Kokoro TTS adapter — produces natural-sounding voice via the open-source
 * Kokoro ONNX model. Not yet wired up. The intended approach:
 *
 *   1. `pip install kokoro-onnx soundfile` (one-time setup)
 *   2. This adapter spawns a python helper at scripts/tts_kokoro.py
 *   3. Text in via stdin, WAV path in via argv, voice via env.
 *
 * The wiring is here so the adapter selector + CLI work consistently. The
 * actual implementation lands when Phase 6 (setup script) is built.
 */

export async function synthesize() {
  throw new Error(
    `kokoro engine is not yet wired up. Run with --engine system for now, or wait for Phase 6 setup.`
  );
}

export async function listVoices() {
  return [];
}
