import { env, exports } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import type { ThinkClientProjectionAgent } from "./agents/client-projection";

// Covers `projectMessagesForClient`: the transcript a client receives is the
// projection on every path — the idle-connect frame, `GET /get-messages`, and
// the `cf_agent_chat_messages` broadcast — while `this.messages` (the model's
// list) is untouched. The test agent's projection is asynchronous, so the
// broadcast test also pins the ordering guarantee: a slow projection queued
// first still reaches the client before a fast one queued after it.

const MSG_CHAT_MESSAGES = "cf_agent_chat_messages";

type ChatMessagesFrame = { type: string; messages: UIMessage[] };

async function freshAgent(name: string) {
  return getAgentByName(
    env.ThinkClientProjectionAgent as unknown as DurableObjectNamespace<ThinkClientProjectionAgent>,
    name
  );
}

async function connectWS(room: string) {
  const res = await exports.default.fetch(
    `http://example.com/agents/think-client-projection-agent/${room}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket as WebSocket;
  ws.accept();
  return ws;
}

/** Resolve with the next `count` CHAT_MESSAGES frames, in arrival order. */
function chatMessagesFrames(
  ws: WebSocket,
  count: number,
  timeout = 3000
): Promise<ChatMessagesFrame[]> {
  return new Promise((resolve, reject) => {
    const frames: ChatMessagesFrame[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(
        new Error(
          `expected ${count} ${MSG_CHAT_MESSAGES} frames, received ${frames.length}`
        )
      );
    }, timeout);
    const onMessage = (event: MessageEvent) => {
      let frame: ChatMessagesFrame;
      try {
        frame = JSON.parse(event.data as string) as ChatMessagesFrame;
      } catch {
        return;
      }
      if (frame.type !== MSG_CHAT_MESSAGES) return;
      frames.push(frame);
      if (frames.length < count) return;
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(frames);
    };
    ws.addEventListener("message", onMessage);
  });
}

function ids(messages: UIMessage[]): string[] {
  return messages.map((message) => message.id);
}

function projectedAs(messages: UIMessage[]): string[] {
  return messages.map(
    (message) => (message.metadata as { projected?: string }).projected ?? ""
  );
}

function closeWS(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 200);
    ws.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
    ws.close();
  });
}

describe("Think — projectMessagesForClient", () => {
  it("hands a connecting socket the projection, not the model's list", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.seedForTest();

    const ws = await connectWS(room);
    const [frame] = await chatMessagesFrames(ws, 1);
    expect(ids(frame.messages)).toEqual(["visible-1", "visible-2"]);
    expect(projectedAs(frame.messages)).toEqual(["connect", "connect"]);

    // The model still reads the whole list.
    expect(await agent.modelMessageIdsForTest()).toEqual([
      "visible-1",
      "internal-1",
      "visible-2"
    ]);
    await closeWS(ws);
  });

  it("serves the projection from GET /get-messages", async () => {
    const agent = await freshAgent(crypto.randomUUID());
    await agent.seedForTest();

    const response = await agent.fetch("https://example.com/get-messages");
    expect(response.headers.get("content-type")).toContain("application/json");
    const messages = (await response.json()) as UIMessage[];
    expect(ids(messages)).toEqual(["visible-1", "visible-2"]);
    expect(projectedAs(messages)).toEqual(["hydrate", "hydrate"]);
  });

  it("broadcasts the projection, in call order even when it is asynchronous", async () => {
    const room = crypto.randomUUID();
    const agent = await freshAgent(room);
    await agent.seedForTest();

    const ws = await connectWS(room);
    await chatMessagesFrames(ws, 1);

    // The first broadcast's projection takes 80ms, the second's none. Without
    // the ordering queue the second snapshot would overtake the first and the
    // client would end on a transcript missing its newest message.
    const pending = chatMessagesFrames(ws, 2);
    await agent.broadcastSeriesForTest([80, 0]);
    const [first, second] = await pending;

    expect(ids(first.messages)).toEqual(["visible-1", "visible-2", "series-0"]);
    expect(ids(second.messages)).toEqual([
      "visible-1",
      "visible-2",
      "series-0",
      "series-1"
    ]);
    expect(projectedAs(second.messages)).toEqual([
      "broadcast",
      "broadcast",
      "broadcast",
      "broadcast"
    ]);
    await closeWS(ws);
  });
});
