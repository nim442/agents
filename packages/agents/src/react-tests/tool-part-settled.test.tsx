/**
 * A settled tool part must not regress on the tab that owns the turn.
 *
 * The stream is the freshest view of an in-flight assistant message: once a
 * `tool-output-available` chunk lands, the tool card shows done. Server frames
 * that carry a copy of the same message can trail the stream — a
 * `cf_agent_message_updated` built from the stored row, or a
 * `cf_agent_chat_messages` snapshot read from storage — and replacing the
 * local message with such a copy flips the card back to running for one
 * commit until the next chunk rewrites it. Invisible in a frame count, visible
 * as a spinner blink on a card that already settled.
 *
 * Each case drives the real hook through a fake `EventTarget` agent on the
 * transport-owned path (the socket that owns the turn) and records the tool
 * part's state on every render: the sequence may never go back from an
 * output state to an input state.
 */
import type { UIMessage } from "ai";
import { useEffect } from "react";
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
const MESSAGE_UPDATED = "cf_agent_message_updated";

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

function user(id: string, body: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text: body }] };
}

/** The server's copy of the streaming message with the tool still running. */
function behindAssistant(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-program",
        toolCallId: "call-1",
        state: "input-available",
        input: { code: "run()" }
      } as UIMessage["parts"][number]
    ]
  };
}

type Harness = {
  read: (id: string) => string | null | undefined;
  /** The tool part's state on every render, in order. */
  states: string[];
  sentMessages: string[];
  target: EventTarget;
};

async function mount(name: string): Promise<Harness> {
  const { agent, sentMessages, target } = createFakeAgent(name);
  const states: string[] = [];

  function TestComponent() {
    const chat = useAgentChat({
      agent,
      getInitialMessages: null,
      messages: [user("u1", "run the program")],
      throttle: false
    });
    const part = chat.messages
      .flatMap((m) => m.parts)
      .find(
        (p) =>
          "toolCallId" in p &&
          (p as { toolCallId?: string }).toolCallId === "call-1"
      ) as { state?: string } | undefined;
    const state = part?.state ?? "none";
    useEffect(() => {
      if (states.at(-1) !== state) states.push(state);
    });
    return (
      <div>
        <div data-testid="status">{chat.status}</div>
        <div data-testid="state">{state}</div>
        <div data-testid="order">
          {chat.messages.map((m) => m.id).join(",")}
        </div>
      </div>
    );
  }

  const { container } = await render(<TestComponent />);
  return {
    read: (id) =>
      container.querySelector(`[data-testid="${id}"]`)?.textContent ?? null,
    states,
    sentMessages,
    target
  };
}

/** Owning-socket turn up to and including the tool output. */
async function streamToolOutput(h: Harness, requestId: string) {
  await vi.waitFor(() =>
    expect(countType(h.sentMessages, RESUME_REQUEST)).toBe(1)
  );
  dispatch(h.target, { id: requestId, type: RESUMING });
  await sleep(10);
  for (const body of [
    { messageId: "a1", type: "start" },
    { type: "start-step" },
    {
      toolCallId: "call-1",
      toolName: "program",
      type: "tool-input-start"
    },
    {
      input: { code: "run()" },
      toolCallId: "call-1",
      toolName: "program",
      type: "tool-input-available"
    },
    {
      output: { rows: 3 },
      toolCallId: "call-1",
      type: "tool-output-available"
    }
  ]) {
    dispatch(h.target, {
      body: JSON.stringify(body),
      done: false,
      id: requestId,
      replay: true,
      type: CHAT_RESPONSE
    });
  }
  await vi.waitFor(() => expect(h.read("state")).toBe("output-available"));
}

async function finishTurn(h: Harness, requestId: string) {
  for (const body of [
    { id: "t1", type: "text-start" },
    { delta: "done.", id: "t1", type: "text-delta" },
    { id: "t1", type: "text-end" }
  ]) {
    dispatch(h.target, {
      body: JSON.stringify(body),
      done: false,
      id: requestId,
      type: CHAT_RESPONSE
    });
  }
  dispatch(h.target, {
    body: "",
    done: true,
    id: requestId,
    type: CHAT_RESPONSE
  });
  await vi.waitFor(() => expect(h.read("status")).toBe("ready"));
  await sleep(50);
}

/** True when an output state is followed, anywhere later, by an input state. */
function regressed(states: string[]): boolean {
  let settled = false;
  for (const state of states) {
    if (state.startsWith("output-")) settled = true;
    else if (settled && state.startsWith("input-")) return true;
  }
  return false;
}

describe("settled tool part on the owning socket", () => {
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

  it("is not downgraded by a message_updated frame built from a stale row", async () => {
    const h = await mount("settled-updated");
    await streamToolOutput(h, "req-1");

    dispatch(h.target, {
      message: behindAssistant("a1"),
      type: MESSAGE_UPDATED
    });
    await sleep(30);
    await finishTurn(h, "req-1");

    expect({ states: h.states, regressed: regressed(h.states) }).toEqual({
      states: expect.arrayContaining(["output-available"]),
      regressed: false
    });
    expect(h.read("state")).toBe("output-available");
  });

  it("is not downgraded by a chat_messages snapshot read from a stale row", async () => {
    const h = await mount("settled-snapshot");
    await streamToolOutput(h, "req-2");

    dispatch(h.target, {
      messages: [user("u1", "run the program"), behindAssistant("a1")],
      type: CHAT_MESSAGES
    });
    await sleep(30);
    await finishTurn(h, "req-2");

    expect(regressed(h.states)).toBe(false);
    expect(h.read("state")).toBe("output-available");
    expect(h.read("order")).toBe("u1,a1");
  });

  it("is not downgraded by a snapshot that also carries a later assistant row", async () => {
    const h = await mount("settled-later-row");
    await streamToolOutput(h, "req-3");

    // The transcript advanced past the streaming message (a server-appended
    // row after it), so the snapshot is taken as the order of record — but
    // its copy of the streaming message still trails the stream.
    dispatch(h.target, {
      messages: [
        user("u1", "run the program"),
        behindAssistant("a1"),
        {
          id: "a2",
          role: "assistant",
          parts: [{ type: "text", text: "notice" }]
        } as UIMessage
      ],
      type: CHAT_MESSAGES
    });
    await sleep(30);
    await finishTurn(h, "req-3");

    expect(regressed(h.states)).toBe(false);
    expect(h.read("state")).toBe("output-available");
  });
});
