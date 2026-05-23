/**
 * HyperFrames TTS adapter — uses the HyperFrames /hyperframes-media endpoint.
 * Not yet wired up. The intended approach:
 *
 *   1. Read endpoint URL + API key from env (HYPERFRAMES_URL, HYPERFRAMES_KEY)
 *   2. POST { text, voice } to /hyperframes-media/tts
 *   3. Stream response body to outPath
 *
 * The wiring is here so the adapter selector + CLI work consistently. The
 * actual implementation lands when Phase 5 (video) is built, since the
 * HyperFrames request shape is best fixed together with the renderer.
 */

export async function synthesize() {
  throw new Error(
    `hyperframes engine is not yet wired up. Run with --engine system for now, or wait for Phase 5.`
  );
}

export async function listVoices() {
  return [];
}
