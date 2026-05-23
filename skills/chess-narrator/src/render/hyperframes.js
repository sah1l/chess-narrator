/**
 * HyperFrames renderer adapter — produces video via the HyperFrames toolchain.
 * Not yet wired up. Intended behavior:
 *
 *   1. Read manifest.json + per-shot HTML files
 *   2. Invoke HyperFrames with the manifest as input
 *   3. HyperFrames renders each HTML to frames, mixes audio, outputs MP4
 *
 * Wiring lands during Phase 6 (skill packaging) when the HyperFrames CLI
 * shape is fixed alongside the setup script.
 */

export async function render() {
  throw new Error(
    `hyperframes renderer is not yet wired up. Use --renderer ffmpeg (requires Chrome + ffmpeg in PATH) or open preview.html in a browser to view the result.`
  );
}
