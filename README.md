# OpenCode Memory System Plugin

A practical memory plugin for OpenCode with:

- Session-based JSON memory storage
- Cross-session recall (intent-triggered + manual)
- Token budget compaction
- Local dashboard on `http://127.0.0.1:37777`
- Dashboard edit/delete with audit log
- Dashboard lifecycle synced with OpenCode web lifecycle

## Files

- `plugins/memory-system.js`
- `plugins/scripts/opencode_memory_dashboard.mjs`

## Install

1. Copy `plugins/memory-system.js` into your OpenCode global plugins directory.
2. Copy `plugins/scripts/opencode_memory_dashboard.mjs` into your OpenCode global plugins scripts directory.
3. Restart OpenCode.

## Typical plugin locations

- macOS/Linux (common):
  - `~/.config/opencode/plugins/memory-system.js`
  - `~/.config/opencode/plugins/scripts/opencode_memory_dashboard.mjs`
- Windows (common):
  - `%USERPROFILE%\\.config\\opencode\\plugins\\memory-system.js`
  - `%USERPROFILE%\\.config\\opencode\\plugins\\scripts\\opencode_memory_dashboard.mjs`

## Runtime data

Stored under:

- `~/.opencode/memory/projects/<project>/sessions/*.json`
- `~/.opencode/memory/global.json`
- `~/.opencode/memory/dashboard/`
- `~/.opencode/memory/audit/memory-audit.jsonl`

## Notes

- Default OpenCode web port assumed by plugin: `4096`.
- Dashboard port: `37777`.
- Requires `node` in PATH.
