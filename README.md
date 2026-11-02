# Suratan

The Kias project's story tool. Write [Ink](https://github.com/inkle/ink), see it
as a graph, plan it on a board of days and hours, play it, and let a bot play it thousands of times. It runs in a
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
- `timeline.js`: what the Story and Plan boards share: rows, time across, cards, dragging, undo
- `plan.js`: the Plan tab: `plan.ink`, one day's board, places down and hours across
- `story.js`: the Story tab: `story.ink`, the whole story from December 2007 to August 2010, threads down and weeks across, as a board or an outline
- `notes.js`: the Notes tab: pages of plain thinking, one Markdown file each, in `notes/` inside the story's folder
- `check-worker.js`: the bot, in a worker so a looping story can't freeze the page
- `ink-guard.js`: makes dividing by zero an Ink error, here and in the bot
- `github.js`: reads and writes one folder of the story's repository through GitHub's API, and a file's earlier versions
- `sw.js`: keeps the tool working offline
- `vendor/ink-full.js`: [inkjs](https://github.com/y-lohse/inkjs) 2.4.0, the Ink compiler and runtime (MIT). One change from the published file: `WriteFloat` writes a whole-number decimal as `"7.0f"` and the reader takes a minus sign on it, so `7.0` stays a decimal through the JSON Suratan runs from, instead of becoming the whole number `7`, which divides differently

No build step. To run it locally, serve this folder with any static server.

## Conventions for the game
The game reads the same `.ink` files later.
- `# speaker: name` says who speaks a line.
- Clock, money and inventory are plain variables and lists the game can read.
- `EXTERNAL name(args)` is something only the game can do. Here it just succeeds.

## The plan
`plan.ink` holds the board as Ink comments, so no compile ever sees it. The game can ignore it. By hand:

```
// places: Home, Kedai, Study
// day 1 | 8-10 | Home | once | morning, the note -> morning
// days 1-7 | 8-22 | Kedai | open | the kedai is open -> kedai
// day 1 | 14-16:30 | Study | once | the drawer
```

`story.ink` is the same kind of file for the Story tab. A month counts as four weeks, so `jan08 3` is January 2008's third week. The older names with no year (`dec` to `jun`) still read as December 2007 to June 2008:

```
// threads: The father, The journal
// mark mar08 | results
// mark may08-jun08 | intake letter
// dec07 3 - jan08 2 | The father | the quiet house | note: The father | day: 1
```

In `plan.ink`, each card is days, hours, place, `once` (a moment he can miss) or `open` (a window), then its words. `-> name` links a scene; without it the card isn't written yet. Other comments are left where they are.
