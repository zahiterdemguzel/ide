# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. It holds only the **rules and coding style**. Everything else — what the app is, how it's built, and how each subsystem works — lives in the memory folder.

## Where project knowledge lives

Project knowledge lives in `.claude/memory/`, not in this file. Start at [`.claude/memory/MEMORY.md`](.claude/memory/MEMORY.md): it's a small always-consult index that links to detail files. The detail files are **read on demand, never all upfront** — open only the one whose area your task touches, and read only the section you need. Don't pre-read them "for context."

## Working rules for agents

- **Keep memory docs in sync with code.** When you change behavior, add/edit/remove the matching file under `.claude/memory/` in the same change, and update its line in `.claude/memory/MEMORY.md` if you add or remove a file. Docs that lie are worse than none.
- **Keep tests and lint green.** Run `npm test` and `npm run lint` before finishing a change. When you touch the pure logic (the modules listed in [`.claude/memory/testing.md`](.claude/memory/testing.md)), add or update a test in the same change; new behavior with no test is incomplete. Keep OS/IPC-touching code thin and push real logic into an Electron-free helper (`run-configs-lib.js`, `git-parse.js`, `edit-ops.js`) so it stays testable. Passing `npm test` and `npm run lint` is enough to consider a change verified — you do not need to launch the app to test it.
- **Write self-explanatory code.** Clear names, small functions, obvious control flow. Reserve comments for the non-obvious *why* (e.g. a platform workaround), not for restating *what* the code does. If a behavior needs prose to be understood, prefer making the code clearer first, then document the genuinely surprising part in `.claude/memory/`.
- **Conserve context.** Read only the doc section you need (use the architecture [Map](.claude/memory/architecture.md#map--start-here) and `Files` table), not whole files. Locate code with grep/glob, then read only the matched range. For broad cross-tree sweeps, delegate to an `Explore` agent so file dumps stay out of the main context. For most changes, read just the pure-logic helper + its test rather than the Electron wiring. Don't re-read a file after editing it.
