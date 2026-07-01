---
name: icon-style-preference
description: User prefers simple/minimal brand glyphs over busy or abstract logos for file-type icons
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4bacb50d-0dc4-4709-bee3-8d89e8f6adbd
---

For the explorer file-type icons, the user rejected the Devicon Go/Lua/Elixir logos as too busy/abstract and asked for "more basic icons or create". Replaced them with Simple Icons single-path brand glyphs (recolored to read on the dark tree).

**Why:** They want icons that are instantly recognizable and clean, not detailed mascots or abstract marks that don't read at 16px.

**How to apply:** When picking brand/language icons, prefer minimal single-color glyphs (Simple Icons) over detailed multi-shape logos (some Devicon "original" variants). Recolor dark brand colors to a lighter tone so they stay visible on the dark tree. The icon set + mapping lives in `src/renderer/file-icons/` and `src/renderer/shared/file-icons.js`.
