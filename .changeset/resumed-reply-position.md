---
"agents": patch
---

`useAgentChat` restores a streamed assistant reply to the position the server's `cf_agent_chat_messages` snapshot gave it once the turn is `done`, instead of the position the client latched when the `start` chunk arrived. A tab that reloaded mid-turn, or one whose list trailed the server's, rendered the resumed reply above the messages that precede it until the next reload.

A server copy of a message (`cf_agent_message_updated`, or a `cf_agent_chat_messages` snapshot) no longer takes a tool part the stream already settled back to an input state. Both are built from the stored row, which can trail the live stream by a chunk, and replacing the local message wholesale flipped a finished tool card back to running for one commit.
