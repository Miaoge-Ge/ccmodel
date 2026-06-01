/** Provider registry: maps a route type to its Provider. */
import type { RouteType } from "../types.js";
import type { Provider } from "./provider.js";
import { anthropicProvider } from "./anthropicProvider.js";
import { openaiProvider } from "./openaiProvider.js";
import { codexProvider } from "./codexProvider.js";
import { cursorProvider } from "./cursorProvider.js";

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
