---
name: chess-narrator
description: Turn a chess game (PGN file, Lichess/Chess.com URL, raw FEN, or inline PGN) into a narrated MP4 explainer video — continuous gameplay where the pieces slide move-to-move and the evaluation bar moves live. Stockfish provides truth (eval, best moves, multipv); the user (or Claude) writes natural teaching narration; edge-tts + HyperFrames produce the final animated video. Obvious moves slide by quickly, critical moments get full commentary, plus one "pause and think" puzzle — a typical game runs 5–7 minutes. Use this skill when the user shares a chess game and wants a video/explainer/walkthrough. Also invoked when the user asks to verify or check the chess-narrator setup.
when_to_use: |
  Invoke when the user:
    - shares a PGN file, Lichess game URL, Chess.com URL, raw FEN, or inline PGN AND asks for a video/explainer/walkthrough
    - asks to make a chess game "into a video", "explain a chess game", or anything similar
    - wants a narrated breakdown of a single position (FEN) — uses position mode
    - asks to "verify chess-narrator", "check chess-narrator setup", "is chess-narrator installed", or any env-readiness question for this skill → run the verify subcommand (see Verifying the environment below)
  Do NOT use for general chess Q&A, opening theory, or position evaluation that doesn't end in a video artifact.
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Chess Narrator

A pipeline that converts a chess game into a narrated MP4 explainer video designed for intermediate club players. The video plays as **continuous gameplay** — one board where the pieces slide move-to-move and the evaluation bar rises and falls live — pausing only at the moments that matter. Obvious moves slide by quickly; critical decisions get the full coach treatment, plus one "pause and think" puzzle. A typical game lands in the **5–7 minute** range.

## Architecture (three layers, one direction)

```
Input (PGN / URL / FEN)
        │
        ▼
[Stockfish]  ── annotation.json (per-ply evals, classifications, key moments, challenge pick)
        │
        ▼
[Claude]     ── narration.json (intro/segments/challenge/outro, one segment per ply, paced)
        │
        ▼
[edge-tts + HyperFrames]  ── video.mp4 (1920x1080 continuous animation, ~5–7 min)
```

- **Stockfish is truth.** Evals, best moves, multipv, brilliancies, mistakes — all decided by the engine. Claude never overrides.
- **Claude is the teacher.** Turns the structured analysis into natural, instructive narration with a coach's voice, paced to the engine-derived tiers.
- **Renderer is delivery.** Edge-tts neural voices for narration; **HyperFrames** (default) renders one animated composition — sliding pieces + a live eval bar — deterministically frame-by-frame to MP4. The legacy **ffmpeg** still renderer (one static board per shot) remains as an offline fallback.

## Verifying the environment

When the user asks to verify the setup ("verify chess-narrator", "check the chess-narrator setup", "is everything installed?", "does this skill work on my machine?"), run a single command and report the result. Do not pre-check pieces by hand — the CLI already does it cross-platform.

```bash
node src/cli.js verify
# Optional: --skip-network to skip the edge-tts reachability probe
```

The command prints a per-check status table (Node ≥22, stockfish/chess.js/msedge-tts npm packages, ffmpeg on PATH, Chrome/Edge/Chromium on PATH or standard install dirs, the HyperFrames CLI, edge-tts WebSocket reachability) and exits 0 when all *required* deps are present, 1 otherwise. The HyperFrames CLI check is a `[WARN]` (not required): it is fetched automatically via `npx` on the first render and the ffmpeg renderer is the offline fallback.

How to act on the result:

- **All `[OK]`** → tell the user they're ready and suggest the next step (`node src/cli.js analyze <input>`).
- **Any `[MISS]` (required)** → relay the inline install hint verbatim. Do not propose your own install commands — the hint already accounts for the user's OS. If they want help running the suggested install, offer to run it for them (with confirmation for anything that mutates system state).
- **Any `[WARN]` (optional, e.g. msedge-tts missing or edge-tts unreachable)** → mention it but don't block. Default `system` voice still works; only `--engine edge` needs those.
- If `node src/cli.js verify` itself fails to start (Node missing entirely, repo not installed at the expected path), fall back to telling the user how to install Node and re-clone the skill.

## End-to-end usage

```bash
# 1. Analyze (Stockfish): writes samples/output/annotation.json
node src/cli.js analyze samples/sample-game.pgn

# 2. Generate narration prompt for Claude:
node src/cli.js narrate-prompt samples/output/annotation.json --out /tmp/prompt.txt

# 3. (Claude writes narration.json from the prompt — see Step 2 below)

# 4. Build shot list (combines annotation + narration):
node src/cli.js build-script samples/output/annotation.json my-narration.json

# 5. Synthesize narration audio (edge-tts neural voices, ~2 min for 30+ shots):
node src/cli.js synthesize samples/output/script.json --engine edge

# 6. Render the MP4 (default renderer = hyperframes, continuous animation):
node src/cli.js render samples/output/script.audio.json --mp4 video.mp4
#    Offline / no HyperFrames CLI? fall back to the still renderer:
node src/cli.js render samples/output/script.audio.json --renderer ffmpeg --mp4 video.mp4
```

The sample (`samples/sample-game.pgn` = Morphy's Opera Game) demonstrates the full pipeline with a hand-written narration at `samples/sample-narration.json`.

## Input formats — `analyze` accepts any of these

The first stage (`analyze`) auto-detects the input form. Pick whichever the user gave you:

```bash
# PGN file on disk
node src/cli.js analyze ./games/my-game.pgn

# Lichess game URL (fetches PGN over the Lichess API — needs internet)
node src/cli.js analyze https://lichess.org/abc123XYZ
node src/cli.js analyze https://lichess.org/abc123XYZ/black   # color suffix is OK

# Chess.com game URL (live or daily)
node src/cli.js analyze https://www.chess.com/game/live/123456789
node src/cli.js analyze https://www.chess.com/game/daily/987654321

# Raw FEN — single-position mode (no game arc, no challenge ply, different narration shape)
node src/cli.js analyze --fen "r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQ - 6 6"

# Inline PGN text the user pasted into chat — write it to a temp file first, then analyze that
#   (Don't try to pass multi-line PGN as a single CLI argument; quoting breaks across shells.)
TMP=$(mktemp --suffix=.pgn) && cat > "$TMP" <<'EOF'
[Event "Casual"]
[White "Alice"]
[Black "Bob"]
1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 ...
EOF
node src/cli.js analyze "$TMP"
```

On Windows/PowerShell, write the pasted PGN to a temp file with `Set-Content` (or use the `Write` tool) rather than `mktemp`/heredocs, then pass that path to `analyze`.

When in doubt about which form you have, just hand the string to `analyze` — it sniffs URL → file path → inline PGN → inline FEN in that order, and errors clearly if none match.

## How Claude writes narration (Step 2)

The `narrate-prompt` command produces a system + user prompt pair. The user prompt contains:
- Game headers (players, event, result, opening)
- A per-ply briefing with: move SAN, evaluation before/after, classification, tier (book/routine/interesting/critical), engine alternative if relevant
- (Optional) a CHALLENGE block describing one ply where the viewer should pause and think — including the engine's top multipv lines

Claude returns a single JSON object conforming to `schemas/narration.schema.json` (currently v1.3.0):

```json
{
  "schemaVersion": "1.3.0",
  "title": "...",
  "subtitle": "...",
  "intro": { "text": "...", "estimatedSeconds": 14 },
  "segments": [
    { "plyIndex": 0, "text": "", "estimatedSeconds": 0, "pace": "silent" },
    { "plyIndex": 11, "text": "...", "estimatedSeconds": 12, "pace": "full", "depth": "deep" },
    ...
  ],
  "challenge": {
    "plyIndex": 30,
    "prompt": { "text": "Pause...", "estimatedSeconds": 12 },
    "thinkSeconds": 7,
    "candidates": [
      { "san": "Rxd7+", "uci": "d1d7", "text": "It looks crushing but...", "estimatedSeconds": 10 },
      { "san": "Qxe6+", "uci": "b3e6", "text": "Tempting queen trade but...", "estimatedSeconds": 10 }
    ],
    "reveal": { "text": "The answer is Qb8!...", "estimatedSeconds": 15 }
  },
  "outro": { "text": "...", "estimatedSeconds": 12 }
}
```

Validation rules (enforced by `build-script`):
- `segments.length === annotation.plies.length` (one segment per ply, in order)
- `segments[i].plyIndex === plies[i].plyIndex`
- If `annotation.challenge != null`, `narration.challenge` must be present with matching `plyIndex`

## Pacing & narration depth

Every ply carries an engine-derived **pace** that controls how much screen time it earns. This is what keeps the video in the 5–7 minute range: most moves slide by, and the coach only stops to talk at the moments that matter. Pace is derived from the commentary tier and **recomputed authoritatively by `build-script`** from the annotation — so a quiet move can't be padded into a long one, regardless of what the narration says.

| Pace | From tier | On screen | Narration |
|---|---|---|---|
| **silent** | book | piece slides (~1s), no voice | `text: ""` (none) |
| **brief** | routine / interesting | quick slide + one short line | 1 clause, ~1.5–3s |
| **full** | critical — `inaccuracy`/`mistake`/`blunder`/`brilliant`/`turning-point`/key moment | board holds, arrows + highlights, full coach treatment | 3–5 sentences, 8–18s |

So the opening and quiet maneuvering play as a near-silent montage of sliding pieces; the engine's mistakes, brilliancies, and turning points are where the video slows down and the narrator speaks. The narration prompt prints the pace next to every move, and the continuous renderer animates each accordingly. The `pace`↔tier mapping lives in `src/narrate/summary.js` (`tierToPace`).

## Challenge moment (pause and think)

One ply per game is auto-selected as the challenge — the latest "brilliant" or "turning-point" where the played move equals the engine's #1 line and multipv has a clearly best move. The video shows:

1. **Prompt** (~10s): "Pause. What would you play here?"
2. **Think** (~6s): silent board, no narration
3. **Candidate 1** (~10s): tempting wrong move with red arrow + reason it fails
4. **Candidate 2** (~10s): another wrong move + reason
5. **Reveal** (~15s): the answer with green arrow + walkthrough of the forcing line

Skipped when no qualifying moment exists (short games, no brilliancies).

## Engines, voices, and renderers

- **TTS engines:** `system` (Windows SAPI, free, robotic), `edge` (Microsoft Edge neural, free, requires internet + ffmpeg, recommended), `kokoro` (offline neural, future)
- **Default voice (edge):** `en-US-AndrewMultilingualNeural` — warm narrator. Try `en-US-GuyNeural` (clear broadcast) or `en-US-ChristopherNeural` (deeper).
- **Renderers:**
  - `hyperframes` (**default**) — continuous animated board + live eval bar, rendered deterministically frame-by-frame to MP4. Fetched via `npx hyperframes` on first use (needs internet once, then cached) and brings its own Chromium + ffmpeg.
  - `ffmpeg` — still-slideshow fallback (one static board per shot, looped under its audio). Needs Chrome/Edge + ffmpeg on PATH. Use it for fully offline renders: `--renderer ffmpeg`.
- **Board themes (`--board-theme`, hyperframes renderer):** `green` (default, Chess.com look), `brown` (lichess), `blue` (cool slate). The board always shows file letters `a`–`h` and rank numbers `1`–`8` so the commentary's square references line up. When the user asks for a particular board color/style, pass it through — e.g. `--board-theme brown`.

## External dependencies

- **Node ≥22**
- **Stockfish** (npm package `stockfish` — auto-installed)
- **ffmpeg** on PATH (for `--engine edge` and `--renderer ffmpeg`; the hyperframes CLI bundles its own for rendering)
- **Chrome / Chromium** on PATH (for the ffmpeg renderer's headless screenshots; hyperframes manages its own browser)
- **HyperFrames CLI** (default renderer) — auto-fetched via `npx hyperframes` on first render (internet once, then cached)

Run `scripts/setup.ps1` (Windows) or `scripts/setup.sh` (macOS/Linux) to verify the environment.

## Notes for Claude when invoking

- Always inspect the user's input form before running `analyze`. Lichess URLs need internet; FEN strings use `--fen`; raw PGN text can be piped through a temp file.
- **Key moments / challenge pick are an opt-in detour, not a default step.** After `analyze` finishes, go straight to `narrate-prompt` → narration → render. Only surface the key-moments list (and engine reasoning behind specific moves) when the user explicitly asks for detail about *why* a particular move is good/bad — e.g. "explain move 17 in depth", "what made Qb8 brilliant?", "walk me through the turning point". Otherwise stay quiet about them; the per-ply narration already covers them in-line and surfacing the raw list up front just adds noise.
- When writing narration, do not invent moves not present in the briefing's pvSan or the position's legal moves. For challenge candidates, the prompt explicitly permits picking human-natural moves from the position even if Stockfish's top-3 are passive.
- Run the full test suite (`npm test`) after any code change to the pipeline.
