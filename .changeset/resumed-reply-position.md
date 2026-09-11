---
"agents": patch
---

`useAgentChat` restores a streamed assistant reply to the position the server's `cf_agent_chat_messages` snapshot gave it once the turn is `done`, instead of the position the client latched when the `start` chunk arrived. A tab that reloaded mid-turn, or one whose list trailed the server's, rendered the resumed reply above the messages that precede it until the next reload.
