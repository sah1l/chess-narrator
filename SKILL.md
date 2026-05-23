---
name: chess-game-explainer
description: Turn a chess game (PGN file, Lichess/Chess.com URL, raw FEN, or inline PGN) into a narrated MP4 explainer video. Stockfish provides truth (eval, best moves, multipv); the user (or Claude) writes natural teaching narration; ffmpeg + edge-tts produce the final video. Use this skill when the user shares a chess game and wants a video that walks through every move with tiered commentary, plus one "pause and think" puzzle at a critical position.
when_to_use: |
  Invoke when the user:
    - shares a PGN file, Lichess game URL, Chess.com URL, raw FEN, or inline PGN AND asks for a video/explainer/walkthrough
    - asks to make a chess game "into a video", "explain a chess game", or anything similar
    - wants a narrated breakdown of a single position (FEN) — uses position mode
  Do NOT use for general chess Q&A, opening theory, or position evaluation that doesn't end in a video artifact.
allowed_tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
---

# Chess Game Explainer

A pipeline that converts a chess game into a narrated MP4 explainer video designed for intermediate club players. The video walks through every move with tiered commentary (book / routine / interesting / critical) and includes one "pause and think" puzzle at a critical position where the viewer is asked to find the right move.

## Architecture (three layers, one direction)

```
Input (PGN / URL / FEN)
        │
        ▼
[Stockfish]  ── analyze.json (per-ply evals, classifications, key moments, challenge pick)
        │
        ▼
[Claude]     ── narration.json (intro/segments/challenge/outro, one segment per ply)
        │
        ▼
[edge-tts + ffmpeg]  ── video.mp4 (1920x1080, ~5–7 min for a typical game)
```

- **Stockfish is truth.** Evals, best moves, multipv, brilliancies, mistakes — all decided by the engine. Claude never overrides.
- **Claude is the teacher.** Turns the structured analysis into natural, instructive narration with a coach's voice.
- **Renderer is delivery.** Edge-tts neural voices for narration, Chrome headless for board screenshots, ffmpeg for video stitching.

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

# 6. Render the MP4:
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

Claude returns a single JSON object conforming to `schemas/narration.schema.json` (currently v1.2.0):

```json
{
  "schemaVersion": "1.2.0",
  "title": "...",
  "subtitle": "...",
  "intro": { "text": "...", "estimatedSeconds": 14 },
  "segments": [
    { "plyIndex": 0, "text": "...", "estimatedSeconds": 3.5, "depth": "brief" },
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

## Tiered narration depths

| Tier | Trigger | Length | What to write |
|---|---|---|---|
| **book** | `isBookMove === true` | 3–5s, 1 sentence | Name the opening idea, not the move |
| **routine** | `best`/`good`, no engine disagreement | 4–7s, 1–2 sentences | What the move does + plan it supports |
| **interesting** | `best`/`good`, engine had a clear preference | 6–10s, 2–3 sentences | Played move + engine's preference + why one was chosen |
| **critical** | `inaccuracy`/`mistake`/`blunder`/key moment | 10–18s, 3–5 sentences | Full coach treatment: intent, engine line, consequence |

## Challenge moment (pause and think)

One ply per game is auto-selected as the challenge — the latest "brilliant" or "turning-point" where the played move equals the engine's #1 line and multipv has a clearly best move. The video shows:

1. **Prompt** (~10s): "Pause. What would you play here?"
2. **Think** (~6s): silent board, no narration
3. **Candidate 1** (~10s): tempting wrong move with red arrow + reason it fails
4. **Candidate 2** (~10s): another wrong move + reason
5. **Reveal** (~15s): the answer with green arrow + walkthrough of the forcing line

Skipped when no qualifying moment exists (short games, no brilliancies).

## Engines, voices, and renderers

- **TTS engines:** `system` (Windows SAPI, free, robotic), `edge` (Microsoft Edge neural, free, requires internet + ffmpeg, recommended), `kokoro` (offline neural, future), `hyperframes` (cloud, future)
- **Default voice (edge):** `en-US-AndrewMultilingualNeural` — warm narrator. Try `en-US-GuyNeural` (clear broadcast) or `en-US-ChristopherNeural` (deeper).
- **Renderers:** `ffmpeg` (default, requires Chrome + ffmpeg on PATH), `hyperframes` (cloud, future).

## External dependencies

- **Node ≥22**
- **Stockfish** (npm package `stockfish` — auto-installed)
- **ffmpeg** on PATH (for `--engine edge` and `--renderer ffmpeg`)
- **Chrome / Chromium** on PATH (for headless board screenshots)

Run `scripts/setup.ps1` (Windows) or `scripts/setup.sh` (macOS/Linux) to verify the environment.

## Notes for Claude when invoking

- Always inspect the user's input form before running `analyze`. Lichess URLs need internet; FEN strings use `--fen`; raw PGN text can be piped through a temp file.
- **Key moments / challenge pick are an opt-in detour, not a default step.** After `analyze` finishes, go straight to `narrate-prompt` → narration → render. Only surface the key-moments list (and engine reasoning behind specific moves) when the user explicitly asks for detail about *why* a particular move is good/bad — e.g. "explain move 17 in depth", "what made Qb8 brilliant?", "walk me through the turning point". Otherwise stay quiet about them; the per-ply narration already covers them in-line and surfacing the raw list up front just adds noise.
- When writing narration, do not invent moves not present in the briefing's pvSan or the position's legal moves. For challenge candidates, the prompt explicitly permits picking human-natural moves from the position even if Stockfish's top-3 are passive.
- Run the full test suite (`npm test`) after any code change to the pipeline.
