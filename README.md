# Suratan

The Kias project's story tool. Write [Ink](https://github.com/inkle/ink), see it
as a graph, play it, and let a bot play it thousands of times. It runs in a
browser on Mac, iPad and iPhone, offline once loaded.

*Suratan* is Malay: what is written, and what is fated (*suratan takdir*). Beside
*kias*, the veiled meaning, it is the other half of *tersurat* and *tersirat*.

This repository holds code only. Stories stay in their own repository, which can
be private: each device connects with a fine-grained token of its own (Contents:
read and write, that repository only), kept on the device and sent only to
api.github.com.

## Files
- `app.js`: the project; the script (one editor per file, so each keeps its undo), find, play, check and sync panes
- `parse.js`: a light scan of the source for scenes, jumps and variables
- `graph.js`: draws the scan; pan, pinch, find, focus on a scene, and drag one (its place stays on this device, not in the story)
- `check-worker.js`: the bot, in a worker so a looping story can't freeze the page
- `ink-guard.js`: makes dividing by zero an Ink error, here and in the bot
- `github.js`: reads and writes the story's folder through GitHub's API
- `sw.js`: keeps the tool working offline
- `vendor/ink-full.js`: [inkjs](https://github.com/y-lohse/inkjs) 2.4.0, the Ink compiler and runtime (MIT). One change from the published file: `WriteFloat` writes a whole-number decimal as `"7.0f"` and the reader takes a minus sign on it, so `7.0` stays a decimal through the JSON Suratan runs from, instead of becoming the whole number `7`, which divides differently

No build step. To run it locally, serve this folder with any static server.

## Conventions for the game
The game reads the same `.ink` files later.
- `# speaker: name` says who speaks a line.
- Clock, money and inventory are plain variables and lists the game can read.
- `EXTERNAL name(args)` is something only the game can do. Here it just succeeds.
