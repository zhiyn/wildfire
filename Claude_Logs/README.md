# Claude_Logs — Persistent Claude Code Logging System

This directory is the **memory layer** for Claude Code sessions on this repository.
Because each Claude Code session starts fresh, these files carry context forward:
what the project is, what was done last, what is in progress, and what to do next.

It is **documentation only** — nothing here runs or affects the application.

## Files

| File | Purpose | Update cadence |
|---|---|---|
| `README.md` | This guide — how the logging system works. | Rarely. |
| `LOGGING_FORMAT.md` | The exact template every session log must follow. | Rarely. |
| `CURRENT_CONTEXT.md` | Short **living** snapshot of the _current_ state (branch, active task, recent work, known issues, next step). **Overwritten in place each session — never prepended; kept lean (≤ ~150 lines).** | **Every session.** |
| `SESSION_INDEX.md` | Running index table of all session logs. | **Every session** (append one row). |
| `logs/` | One detailed log file per session. | **Every session** (add one file). |

The stable, repo-wide rules live in the root **`CLAUDE.md`**, not here.

## Start-of-session workflow (read, in this order)

1. **`/CLAUDE.md`** — stable project rules and engineering priorities.
2. **`Claude_Logs/CURRENT_CONTEXT.md`** — where things stand right now.
3. **`Claude_Logs/SESSION_INDEX.md`** — scan for relevant past sessions.
4. **The latest relevant `logs/*.md`** — the most recent detailed entry (and any
   older one related to your task).

After reading these four, state your understanding of the current state and your
plan before editing anything.

## End-of-session workflow (write)

1. **Create a new log** at `logs/YYYY-MM-DD_<short-task-slug>.md` using the exact
   structure in `LOGGING_FORMAT.md`. Do not skip sections; write `None` where a
   section is empty.
2. **Overwrite `CURRENT_CONTEXT.md`** — replace the active task, recent work, known
   issues, next recommended step, and the "Last updated" timestamp with the *current*
   state. **Do not prepend** a new entry above the old ones: this file is a snapshot,
   not an archive. The previous session's detail already lives in its `logs/` entry and
   `SESSION_INDEX.md` row, so keep this file lean (≤ ~150 lines); if it has grown past
   that, it has drifted — trim it back.
3. **Append a row to `SESSION_INDEX.md`** for the new log.

## Conventions

- **Log file naming:** `YYYY-MM-DD_<short-kebab-task-slug>.md`
  (e.g. `2026-06-14_initial-claude-logging-setup.md`). If two sessions happen on
  one day, add a suffix: `..._part-2.md`.
- **Timestamps:** use `YYYY-MM-DD HH:MM <TZ>` (local time of the session).
- **Branch:** always record the git branch the work happened on
  (`git branch --show-current`).
- **Append-only history; overwritten snapshot:** never rewrite a past log in `logs/`
  (new information goes in a new log), and `SESSION_INDEX.md` only ever gains rows.
  `CURRENT_CONTEXT.md` is the **opposite** — it is overwritten in place every session to
  reflect only the current state (never prepended; kept ≤ ~150 lines). Because all history
  lives in `logs/` + `SESSION_INDEX.md`, nothing is lost by trimming it.
- **Honesty:** record what actually ran and what passed/failed, including skipped
  verification. A log that overstates completion is worse than no log.
