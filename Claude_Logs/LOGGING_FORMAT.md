# Logging Format

Every session log in `Claude_Logs/logs/` **must** follow this exact structure.
Keep the section headings and their order. If a section has nothing to report,
write `None` rather than deleting the heading.

File location & name: `Claude_Logs/logs/YYYY-MM-DD_<short-task-slug>.md`

---

## Copy-paste template

```markdown
# Session Log — <short title>

## Date / Time
<YYYY-MM-DD HH:MM TZ>

## Git Branch
<output of `git branch --show-current`>

## Session Goal
<One or two sentences: what this session set out to accomplish.>

## Files Inspected
- <path> — <why / what was learned>

## Files Changed
- <path> — <what changed> (created / modified / deleted)

## Summary of Completed Work
<What was actually done, in plain prose or bullets.>

## Important Technical Decisions
- <Decision> — <why; alternatives rejected>

## Tests / Commands Run
- `<command>` — <purpose>

## Results of Verification
- <command or check> → <PASS / FAIL / counts / output summary>
- Explicitly note what was NOT tested.

## Bugs / Issues Discovered
- <bug or issue, with file:line if known> (or `None`)

## Risks / Unresolved Questions
- <risk, assumption, or open question> (or `None`)

## Next Recommended Steps
1. <concrete next action>

## Prompt to Start the Next Session
> <A ready-to-paste prompt that gives the next Claude Code session its goal and
>  the key context/files it needs to resume cleanly.>
```

---

## Field guide

- **Date / Time** — local session time, `YYYY-MM-DD HH:MM TZ`.
- **Git Branch** — the branch the work happened on. Note if you branched or merged.
- **Session Goal** — the intended outcome, set at the start of the session.
- **Files Inspected** — files read to build context (not just files changed).
- **Files Changed** — every created/modified/deleted file, with a short reason.
  For documentation-only sessions, say so explicitly.
- **Summary of Completed Work** — what is now true that wasn't before.
- **Important Technical Decisions** — choices a future maintainer would want the
  rationale for (naming, abstractions, cache-key changes, tier behavior, etc.).
- **Tests / Commands Run** — the actual commands, copy-pasteable.
- **Results of Verification** — pass/fail with evidence (test counts, output).
  Always state what was left unverified.
- **Bugs / Issues Discovered** — anything broken or surprising found along the way.
- **Risks / Unresolved Questions** — assumptions, follow-ups, things to watch.
- **Next Recommended Steps** — ordered, concrete actions for whoever continues.
- **Prompt to Start the Next Session** — a self-contained prompt the user can paste
  to resume; include the task and the files/context the next session should open.
