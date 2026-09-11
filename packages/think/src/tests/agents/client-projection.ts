import type { LanguageModel, UIMessage } from "ai";
import { Think } from "../../think";
import type { ClientProjectionContext } from "../../think";

/**
 * Exercises `projectMessagesForClient`: every client-facing history path
 * must carry the projection, never the model's list. The projection is
 * asynchronous on purpose, and each call can be slowed independently so the
 * ordering of queued broadcasts is observable from a client.
 */
export class ThinkClientProjectionAgent extends Think {
  /** Delays (ms) consumed by successive projections, first call first. */
  private _projectionDelays: number[] = [];
  private _projectionCalls = 0;

  override getModel(): LanguageModel {
    // This agent never runs a turn; its history is seeded through addMessages().
    return {
      specificationVersion: "v3",
      provider: "test",
      modelId: "unused",
      supportedUrls: {},
      doGenerate() {
        throw new Error("ThinkClientProjectionAgent does not run turns");
      },
      doStream() {
        throw new Error("ThinkClientProjectionAgent does not run turns");
      }
    } as unknown as LanguageModel;
  }

  protected override async projectMessagesForClient(
    messages: UIMessage[],
    context: ClientProjectionContext
  ): Promise<UIMessage[]> {
    this._projectionCalls++;
    const delay = this._projectionDelays.shift();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return messages
      .filter((message) => !isInternal(message))
      .map((message) => ({
        ...message,
        metadata: {
          ...(message.metadata as Record<string, unknown> | undefined),
          projected: context.reason
        }
      }));
  }

  /** Two visible messages around one the client must never see. */
  async seedForTest(): Promise<void> {
    await this.addMessages(
      [
        {
          id: "visible-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }]
        },
        {
          id: "internal-1",
          role: "user",
          parts: [{ type: "text", text: "server-only context" }],
          metadata: { internal: true }
        },
        {
          id: "visible-2",
          role: "assistant",
          parts: [{ type: "text", text: "hi" }]
        }
      ],
      { broadcast: false }
    );
  }

  /**
   * Append one message per delay, back to back. Each append broadcasts, and
   * the projection for the i-th broadcast waits `delays[i]` ms, so a slow
   * early broadcast followed by a fast later one tests the ordering queue.
   */
  async broadcastSeriesForTest(delays: number[]): Promise<void> {
    this._projectionDelays = [...delays];
    for (let i = 0; i < delays.length; i++) {
      await this.addMessages([
        {
          id: `series-${i}`,
          role: "user",
          parts: [{ type: "text", text: `series ${i}` }]
        }
      ]);
    }
  }

  /** The model's list: what `this.messages` holds, projection or not. */
  async modelMessageIdsForTest(): Promise<string[]> {
    return this.messages.map((message) => message.id);
  }

  async projectionCallsForTest(): Promise<number> {
    return this._projectionCalls;
  }
}

function isInternal(message: UIMessage): boolean {
  return (
    (message.metadata as { internal?: boolean } | undefined)?.internal === true
  );
}
