---
"@cloudflare/think": minor
---

Add `projectMessagesForClient(messages, context)`, a protected hook that every client-facing history path routes through: the `cf_agent_chat_messages` broadcast, the idle-connect frame, the `GET …/get-messages` hydration route, and the dropped-submit rollback. The default returns `messages` unchanged. Override it to give clients a different list from the one the model reads — the stored conversation with compaction overlays unapplied (`this.session.getHistory({ overlays: false })`), or the same list with server-only parts stripped. `context.reason` names the path (`"broadcast" | "connect" | "hydrate" | "rollback"`); an asynchronous projection is sent in the order Think issued it.
