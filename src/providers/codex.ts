/** GPT-5.5-via-Codex-login provider (wraps the codexClient helper). */
import type { Provider, ProviderRequest } from "./provider.js";
import { emitEvents } from "./provider.js";
import { anthropicToOpenai } from "../pipeline/translate.js";
import * as codex from "./codexClient.js";

/** Reasoning efforts the Codex Responses API accepts. */
const CODEX_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

/**
 * Map the resolved UltraCode effort (already on the request's `output_config`) to
 * a Codex-valid reasoning effort, so codex honors the envelope instead of always
 * running at the helper's default. `xhigh` (Anthropic's max) maps to `high`;
 * anything Codex wouldn't accept returns undefined → the helper's default.
 */
function codexEffort(body: Record<string, unknown>): string | undefined {
  const oc = body.output_config;
  const raw = oc && typeof oc === "object" ? (oc as Record<string, unknown>).effort : undefined;
  if (typeof raw !== "string") return undefined;
  const e = raw.toLowerCase() === "xhigh" ? "high" : raw.toLowerCase();
  return CODEX_EFFORTS.has(e) ? e : undefined;
}

export const codexProvider: Provider = {
  type: "codex_oauth",
  async handle(req: ProviderRequest): Promise<void> {
    const anth = req.ctx.parsed || {};
    // Guard against a misconfigured entry with no `model`: the proxy would leave
    // the auto claude-* alias on the body, which Codex can't resolve. Fall back.
    const raw = req.ctx.modelId || "";
    const modelId = raw && !/^(claude|anthropic)/i.test(raw) ? raw : "gpt-5.5";
    const oai = anthropicToOpenai(anth);
    await emitEvents(
      req,
      () =>
        codex.streamEvents({
          messages: oai.messages,
          tools: oai.tools,
          tool_choice: oai.tool_choice,
          model: modelId,
          reasoning_effort: codexEffort(anth),
          signal: req.ctx.signal,
        }),
      `codex ${modelId}`,
    );
  },
};
