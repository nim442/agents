/**
 * A resumed reply must end up where the server's transcript puts it.
 *
 * While an assistant message streams, `useAgentChat` keeps it at the tail of
 * the list (the AI SDK writes into the last message) and remembers an anchor
 * — the message it followed when the `start` chunk arrived — so it can move
 * the reply back into place once the turn is `done`. That anchor is whatever
 * this client held at that moment. A tab that reloads mid-turn, or one that
 * receives a `cf_agent_chat_messages` snapshot carrying messages it never
 * saw, holds a list that trails the server's, and restoring to the stale
 * anchor rendered the resumed reply above the messages that precede it on the
 * server — until the next reload.
 *
 * The server snapshot is the transcript's order: a snapshot that contains the
 * protected assistant tells the client where it belongs, and the restore at
 * `done` must use that position. This drives the real hook through a fake
 * `EventTarget` agent with the frames a transport-owned resume produces.
 */
import type { UIMessage } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render as _render } from "vitest-browser-react";
import { useAgentChat } from "../chat/react";
import type { useAgent } from "../react";

const render: typeof _render = async (...args) => {
  const result = await _render(...args);
  // @ts-expect-error - globalThis is not typed
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
  return result;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RESUMING = "cf_agent_stream_resuming";
const RESUME_REQUEST = "cf_agent_stream_resume_request";
const CHAT_RESPONSE = "cf_agent_use_chat_response";
const CHAT_MESSAGES = "cf_agent_chat_messages";

function createFakeAgent(name: string) {
  const target = new EventTarget();
  const sentMessages: string[] = [];
  const url = `ws://localhost:3000/agents/chat/${name}?_pk=abc`;
  const agent = {
    _pk: name,
    _pkurl: url,
    _url: null as string | null,
    addEventListener: target.addEventListener.bind(target),
    agent: "Chat",
    close: () => {},
    dispatchEvent: target.dispatchEvent.bind(target),
    getHttpUrl: () => url.replace("ws://", "http://"),
    id: "fake-agent",
    name,
    path: [{ agent: "Chat", name }],
    removeEventListener: target.removeEventListener.bind(target),
    send: (data: string) => sentMessages.push(data)
  };
  return {
    agent: agent as unknown as ReturnType<typeof useAgent>,
    sentMessages,
    target
  };
}

function dispatch(target: EventTarget, data: Record<string, unknown>) {
  target.dispatchEvent(
    new MessageEvent("message", { data: JSON.stringify(data) })
  );
}

const countType = (sent: string[], type: string) =>
  sent.filter((m) => {
    try {
      return (JSON.parse(m) as { type?: string }).type === type;
    } catch {
      return false;
    }
  }).length;

function text(id: string, role: "user" | "assistant", body: string) {
  return { id, role, parts: [{ type: "text", text: body }] } as UIMessage;
}

type Harness = {
  read: (id: string) => string | null | undefined;
  sentMessages: string[];
  target: EventTarget;
};

/** Mount a client whose list holds only `u3`; the server already has more. */
async function mount(name: string): Promise<Harness> {
  const { agent, sentMessages, target } = createFakeAgent(name);

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [text("u3", "user", "three")]
    });
    return (
      <div>
        <div data-testid="status">{chat.status}</div>
        <div data-testid="order">
          {chat.messages.map((m) => m.id).join(",")}
        </div>
        <div data-testid="reply">
          {chat.messages
            .filter((m) => m.id === "a4")
            .flatMap((m) => m.parts)
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("")}
        </div>
      </div>
    );
  }

  const { container } = await render(<TestComponent />);
  return {
    read: (id) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    sentMessages,
    target
  };
}

describe("resumed reply keeps the server's position", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    cleanup();
  });

  it("restores a resumed reply where the server snapshot placed it, not after a stale anchor", async () => {
    const h = await mount("restore-order");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    // The transport owns this resume; the `start` chunk latches the anchor
    // from the client's list, which ends at `u3` — but on the server `a3`
    // and `u4` already follow it.
    dispatch(h.target, { id: "req-4", type: RESUMING });
    await sleep(10);
    for (const body of [
      { messageId: "a4", type: "start" },
      { type: "start-step" },
      { id: "t1", type: "text-start" },
      { delta: "reply four", id: "t1", type: "text-delta" }
    ]) {
      dispatch(h.target, {
        body: JSON.stringify(body),
        done: false,
        id: "req-4",
        replay: true,
        type: CHAT_RESPONSE
      });
    }
    await vi.waitFor(() => expect(h.read("order")).toBe("u3,a4"));

    // The server's transcript, with the reply in place, arrives before the
    // terminal frame (Think persists and broadcasts, then settles the turn).
    dispatch(h.target, {
      messages: [
        text("u3", "user", "three"),
        text("a3", "assistant", "reply three"),
        text("u4", "user", "four"),
        text("a4", "assistant", "reply four")
      ],
      type: CHAT_MESSAGES
    });
    await vi.waitFor(() => expect(h.read("order")).toBe("u3,a3,u4,a4"));

    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-4",
      type: CHAT_RESPONSE
    });
    await vi.waitFor(() => expect(h.read("status")).toBe("ready"));
    // Give the restore's (throttled) render a chance to land before reading.
    await sleep(100);

    expect({ order: h.read("order"), reply: h.read("reply") }).toEqual({
      order: "u3,a3,u4,a4",
      reply: "reply four"
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still restores to the latched anchor when no snapshot named a position", async () => {
    const h = await mount("restore-anchor");
    await vi.waitFor(() =>
      expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
    );

    dispatch(h.target, { id: "req-5", type: RESUMING });
    await sleep(10);
    for (const body of [
      { messageId: "a4", type: "start" },
      { id: "t1", type: "text-start" },
      { delta: "reply four", id: "t1", type: "text-delta" }
    ]) {
      dispatch(h.target, {
        body: JSON.stringify(body),
        done: false,
        id: "req-5",
        replay: true,
        type: CHAT_RESPONSE
      });
    }
    dispatch(h.target, {
      body: "",
      done: true,
      id: "req-5",
      type: CHAT_RESPONSE
    });
    await vi.waitFor(() => expect(h.read("status")).toBe("ready"));
    await sleep(100);

    expect(h.read("order")).toBe("u3,a4");
  });
});
