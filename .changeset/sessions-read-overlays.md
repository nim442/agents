---
"agents": minor
---

`HistoryReadOptions.overlays` (default `true`): pass `overlays: false` to `history()`, `historyBatches()`, or `getHistory()` to read the stored rows underneath a compaction overlay instead of the synthetic `compaction_<id>` summary.
