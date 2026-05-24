import { open } from "node:fs/promises";

/**
 * Read the duration (in seconds) of a WAV file by walking RIFF chunks.
 *
 * We don't trust a fixed 44-byte header — some encoders insert LIST/INFO
 * chunks before 'data'. Walk chunks until we find 'fmt ' (for the byte rate)
 * and 'data' (for the sample count).
 *
 * @param {string} filePath
 * @returns {Promise<number>} duration in seconds
 */
export async function readWavDuration(filePath) {
  const fh = await open(filePath, "r");
  try {
    const header = Buffer.alloc(12);
    await fh.read(header, 0, 12, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF") {
      throw new Error(`Not a RIFF file: ${filePath}`);
    }
    if (header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error(`Not a WAVE file: ${filePath}`);
    }

    let offset = 12;
    let byteRate = null;
    let dataSize = null;

    while (true) {
      const ch = Buffer.alloc(8);
      const { bytesRead } = await fh.read(ch, 0, 8, offset);
      if (bytesRead < 8) break;
      const id = ch.toString("ascii", 0, 4);
      const size = ch.readUInt32LE(4);

      if (id === "fmt ") {
        // PCM fmt chunks are ≥16 bytes; bytes 8-11 carry the ByteRate.
        // Truncated/malformed headers would otherwise overflow readUInt32LE.
        if (size < 16) {
          throw new Error(`Malformed fmt chunk (size=${size}, need ≥16) in ${filePath}`);
        }
        const fmt = Buffer.alloc(16);
        await fh.read(fmt, 0, 16, offset + 8);
        byteRate = fmt.readUInt32LE(8);
      } else if (id === "data") {
        dataSize = size;
        break; // we don't need anything past data
      }

      // Chunks are 2-byte aligned: pad odd sizes by one. Guard against
      // zero-size non-data chunks that would otherwise spin forever.
      const advance = 8 + size + (size % 2);
      if (advance <= 8) {
        throw new Error(`Zero-size chunk '${id}' in ${filePath}`);
      }
      offset += advance;
    }

    if (byteRate == null) throw new Error(`No fmt chunk in ${filePath}`);
    if (dataSize == null) throw new Error(`No data chunk in ${filePath}`);
    return dataSize / byteRate;
  } finally {
    await fh.close();
  }
}
