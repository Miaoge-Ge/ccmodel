/** Provider registry: maps a route type to its Provider. */
import type { RouteType } from "../config/types.js";
import type { Provider } from "./provider.js";
import { anthropicProvider } from "./anthropic.js";
import { openaiProvider } from "./openai.js";
import { codexProvider } from "./codex.js";
import { cursorProvider } from "./cursor.js";

const registry = new Map<RouteType, Provider>();

export function registerProvider(p: Provider): void {
  registry.set(p.type, p);
}

/** Resolve a provider by route type, defaulting to Anthropic passthrough. */
export function resolveProvider(type: RouteType | undefined): Provider {
  return registry.get(type ?? "anthropic") ?? anthropicProvider;
}

export function registeredTypes(): RouteType[] {
  return [...registry.keys()];
}

// Register the built-ins at module load.
for (const p of [anthropicProvider, openaiProvider, codexProvider, cursorProvider]) registerProvider(p);
