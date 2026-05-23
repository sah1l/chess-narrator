import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);

const FLAVOR_BIN = {
  "lite-single": "stockfish-18-lite-single.js",
  "lite": "stockfish-18-lite.js",
  "single": "stockfish-18-single.js",
  "full": "stockfish-18.js",
};

/**
 * Drive the stockfish.js WASM engine as a subprocess via UCI over stdio.
 *
 * Lifecycle:
 *   const engine = await createEngine();
 *   const e = await engine.evaluate(fen, { depth: 12, multiPV: 3 });
 *   await engine.quit();
 *
 * Concurrency: evaluate() calls are serialized via an internal mutex.
 */
export async function createEngine({ flavor = "lite-single", multiPV = 3 } = {}) {
  const binName = FLAVOR_BIN[flavor];
  if (!binName) throw new Error(`Unknown stockfish flavor: ${flavor}`);
  const pkgRoot = path.dirname(require.resolve("stockfish/package.json"));
  const binPath = path.join(pkgRoot, "bin", binName);

  const child = spawn(process.execPath, [binPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Hold strong reference to lines for the listener model.
  const listeners = new Set();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    for (const fn of listeners) fn(line);
  });
  child.stderr.on("data", () => {}); // swallow

  function send(cmd) {
    child.stdin.write(cmd + "\n");
  }

  function once(predicate, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(fn);
        reject(new Error(`UCI wait timed out: ${predicate.toString()}`));
      }, timeoutMs);
      const fn = (line) => {
        if (predicate(line)) {
          clearTimeout(timer);
          listeners.delete(fn);
          resolve(line);
        }
      };
      listeners.add(fn);
    });
  }

  function collectUntil(predicate, { timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
      const out = [];
      const timer = setTimeout(() => {
        listeners.delete(fn);
        reject(new Error("UCI collect timed out"));
      }, timeoutMs);
      const fn = (line) => {
        out.push(line);
        if (predicate(line)) {
          clearTimeout(timer);
          listeners.delete(fn);
          resolve(out);
        }
      };
      listeners.add(fn);
    });
  }

  // UCI handshake
  send("uci");
  await once((l) => l === "uciok");
  send(`setoption name MultiPV value ${multiPV}`);
  send("isready");
  await once((l) => l === "readyok");

  let busy = Promise.resolve();
  const enqueue = (fn) => {
    const next = busy.then(fn, fn);
    // Don't let one failed eval poison the queue.
    busy = next.catch(() => {});
    return next;
  };

  async function setPosition(fen) {
    send(`position fen ${fen}`);
    send("isready");
    await once((l) => l === "readyok");
  }

  /**
   * Evaluate a single position.
   * @param {string} fen
   * @param {{depth: number, multiPV?: number}} opts
   * @returns {Promise<Evaluation>}
   */
  function evaluate(fen, { depth, multiPV: localMultiPV } = {}) {
    if (!depth || depth < 1) throw new Error("depth required");
    return enqueue(async () => {
      if (localMultiPV && localMultiPV !== multiPV) {
        send(`setoption name MultiPV value ${localMultiPV}`);
        send("isready");
        await once((l) => l === "readyok");
        multiPV = localMultiPV;
      }
      await setPosition(fen);
      send(`go depth ${depth}`);
      const lines = await collectUntil((l) => l.startsWith("bestmove"));
      const sideToMove = fen.split(" ")[1] === "b" ? "b" : "w";
      return parseEval(lines, depth, sideToMove);
    });
  }

  async function quit() {
    send("quit");
    rl.close();
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
  }

  return { evaluate, quit, _send: send };
}

/**
 * Parse a batch of UCI output lines into an Evaluation.
 * Scores are returned from White's perspective (UCI is side-to-move POV; we flip for Black).
 */
export function parseEval(lines, depth, sideToMove = "w") {
  const sign = sideToMove === "b" ? -1 : 1;
  const pvByRank = new Map();
  let bestMove = null;
  let bestDepth = depth;

  for (const line of lines) {
    if (line.startsWith("bestmove")) {
      const m = line.match(/bestmove\s+(\S+)/);
      bestMove = m ? m[1] : null;
      if (bestMove === "(none)") bestMove = null;
      continue;
    }
    if (!line.startsWith("info")) continue;
    // Ignore "info string ..." chatter and selective lines.
    if (line.startsWith("info string")) continue;

    const tokens = line.split(/\s+/);
    let mpv = 1;
    let cp = null;
    let mate = null;
    let pv = null;
    let infoDepth = null;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === "multipv") mpv = parseInt(tokens[i + 1], 10);
      else if (t === "depth") infoDepth = parseInt(tokens[i + 1], 10);
      else if (t === "score") {
        const kind = tokens[i + 1];
        const v = parseInt(tokens[i + 2], 10);
        if (kind === "cp") cp = v;
        else if (kind === "mate") mate = v;
      } else if (t === "pv") {
        pv = tokens.slice(i + 1);
        break;
      }
    }
    if (pv == null) continue;
    if (infoDepth != null) bestDepth = Math.max(bestDepth, infoDepth);
    pvByRank.set(mpv, {
      rank: mpv,
      moves: pv,
      cp: cp == null ? null : cp * sign,
      mate: mate == null ? null : mate * sign,
    });
  }

  const pvLines = [...pvByRank.values()].sort((a, b) => a.rank - b.rank);
  const top = pvLines[0] ?? { cp: null, mate: null };

  return {
    cp: top.cp ?? null,
    mate: top.mate ?? null,
    bestMove,
    pvLines,
    depth: bestDepth,
  };
}
