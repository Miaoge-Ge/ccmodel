/** Runtime + per-request context types shared across the server and providers. */
import type { IncomingHttpHeaders } from "node:http";
import type { EnvelopeSettings } from "../pipeline/envelope.js";
import type { DiscoveryModel, Route, Slot } from "../config/types.js";

/** Process-wide state, built once at startup. */
export interface ProxyContext {
  upstream: string;
  settings: EnvelopeSettings;
  slotMap: Record<string, Slot>;
  modelMap: Record<string, string>;
  discoveryModels: DiscoveryModel[];
  version?: string;
  /** Inbound body cap in bytes (0 disables). */
  maxBodyBytes?: number;
}

/** Everything a provider needs to know about one inbound request. */
export interface RequestContext {
  /** Short id for correlating log lines. */
  id: string;
  method: string;
  /** Path without query string. */
  path: string;
  /** Original request-target (path + query), used when forwarding. */
  url: string;
  reqHeaders: IncomingHttpHeaders;
  /** The (possibly transformed) request body. */
  body: Buffer;
  /** Parsed transformed body for /v1/messages, else null. */
  parsed: Record<string, unknown> | null;
  /** Routing decision from the envelope step. */
  route: Route;
  /** Model id echoed back to Claude Code (the backend model). */
  modelId: string;
  wantStream: boolean;
  startedAt: number;
  /** Aborted when the downstream client disconnects. */
  signal: AbortSignal;
}
