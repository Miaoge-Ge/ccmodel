/** GPT-5.5-via-Codex-login provider (wraps the codexOauth helper). */
import type { Provider, ProviderRequest } from "./provider.js";
import { emitEvents } from "./provider.js";
import { anthropicToOpenai } from "../translate.js";
import * as codex from "./codexOauth.js";

export const codexProvider: Provider = {
  type: "codex_oauth",
  async handle(req: ProviderRequest): Promise<void> {
    const anth = req.ctx.parsed || {};
    const modelId = req.ctx.modelId || "gpt-5.5";
    const oai = anthropicToOpenai(anth);
    await emitEvents(
      req,
      () => codex.streamEvents({ messages: oai.messages, tools: oai.tools, tool_choice: oai.tool_choice, model: modelId }),
      `codex ${modelId}`,
    );
  },
};
