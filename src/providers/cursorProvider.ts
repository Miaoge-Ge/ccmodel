/** Cursor Composer provider (experimental; wraps the cursorAgent helper). */
import type { Provider, ProviderRequest } from "./provider.js";
import { emitEvents } from "./provider.js";
import { anthropicToOpenai } from "../translate.js";
import * as cursor from "./cursorAgent.js";

export const cursorProvider: Provider = {
  type: "cursor_agent",
  async handle(req: ProviderRequest): Promise<void> {
    const anth = req.ctx.parsed || {};
    const modelId = req.ctx.modelId || "composer-2.5";
    const oai = anthropicToOpenai(anth);
    // retry=false: re-running the cursor-agent subprocess on an empty turn is
    // expensive and rarely helps.
    await emitEvents(
      req,
      () => cursor.streamEvents({ messages: oai.messages, tools: oai.tools, model: modelId, workspace: req.ctx.route.workspace }),
      `cursor ${modelId}`,
      false,
    );
  },
};
