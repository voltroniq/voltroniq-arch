# Changelog

## Unreleased
- Added `scan` command: index a folder of JS/TS into SQLite
- Added `search` command: fast symbol lookup via FTS5
- Added `impact` command: find callers of a symbol (direct + transitive, with depth limit)
- Parser handles both JavaScript and TypeScript grammars
- Two-pass scan: symbols first, then call edges with confidence tiers

### Known limitations
- Transitive impact confidence reflects the last hop, not the weakest link in the chain
- No import-aware resolution yet — "likely" means "unique name match," not "verified import"

## 0.1.0 — (not yet released)
- Initial project skeleton