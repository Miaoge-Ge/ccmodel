/**
 * The UltraCode envelope + `[1m]` enforcement — the core request transform.
 *
 * For every POST /v1/messages we:
 *   1. resolve the routing slot (and strip any `[1m]` suffix off the model id),
 *   2. decide whether this request wants a 1M context window,
 *   3. force effort=xhigh + adaptive thinking + a max_tokens floor + the
 *      Ultracode reminder (each toggleable),
 * and hand back the rewritten body plus a Route the server forwards on.
 */
import type { Route, Slot } from "../config/types.js";
import { parseModelId, headerRequests1m } from "./model1m.js";
import { vlog } from "../core/log.js";

export interface EnvelopeSettings {
  /** "" disables effort forcing. */
  forceEffort: string;
  forceThinking: boolean;
  maxTokensFloor: number;
  injectReminder: boolean;
  /** Force 1M on every request regardless of suffix/header. */
  force1m: boolean;
}

type Json = Record<string, unknown>;

export const ULTRACODE_REMINDER =
  "Ultracode is on: optimize for the most exhaustive, correct answer — not " +
  "the fastest or cheapest. Use the Workflow tool on every substantive task; " +
  "token cost is not a constraint. See the Workflow tool's **Ultracode** " +
  "section and quality patterns. Solo only on conversational/trivial turns.";
const REMINDER_FINGERPRINT = "Ultracode is on:";

function systemHasReminder(system: unknown): boolean {
  if (system == null) return false;
  if (typeof system === "string") return system.includes(REMINDER_FINGERPRINT);
  if (Array.isArray(system)) {
    for (const block of system) {
      if (block && typeof block === "object") {
        const txt = (block as Json).text;
        if (typeof txt === "string" && txt.includes(REMINDER_FINGERPRINT)) return true;
      } else if (typeof block === "string" && block.includes(REMINDER_FINGERPRINT)) {
        return true;
      }
    }
  }
  return false;
}

function injectReminder(body: Json): void {
  if (systemHasReminder(body.system)) return;
  const block = { type: "text", text: ULTRACODE_REMINDER };
  const system = body.system;
  if (system == null) {
    body.system = [block];
  } else if (typeof system === "string") {
    body.system = system.replace(/\s+$/, "") + "\n\n" + ULTRACODE_REMINDER;
  } else if (Array.isArray(system)) {
    system.push(block);
  } else {
    body.system = [{ type: "text", text: String(system) }, block];
  }
}

export interface TransformResult {
  body: Buffer;
  route: Route;
}

/**
 * Apply the envelope and resolve routing for a raw /v1/messages body.
 * On parse failure returns the original bytes with an empty route so the proxy
 * never breaks a request.
 */
export function transformMessagesBody(
  raw: Buffer,
  requestHeaders: Record<string, string | string[] | undefined>,
  slotMap: Record<string, Slot>,
  modelMap: Record<string, string>,
  settings: EnvelopeSettings,
): TransformResult {
  let body: Json;
  try {
    const parsed = JSON.parse(raw.toString("utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body: raw, route: {} };
    body = parsed as Json;
  } catch (e) {
    vlog(`body parse failed, passing through: ${String(e)}`);
    return { body: raw, route: {} };
  }

  let changed = false;
  const route: Route = {};
  const modelBefore = typeof body.model === "string" ? body.model : "";
  const { baseId, want1m: suffix1m } = parseModelId(modelBefore);

  // Resolve the slot: prefer an exact match (a route literally keyed with [1m]),
  // then the base id. This lets users key routes either way.
  const slot: Slot | undefined = slotMap[modelBefore] ?? slotMap[baseId];

  // 1M intent: the suffix, an existing beta header (Claude Code already resolved
  // a [1m] model), the global force flag, or a per-route force policy.
  // Only "force" (or the [1m] suffix / global / incoming beta) forces 1M. A plain
  // `"1m": true` merely advertises the variant — the base id stays standard.
  const routeForces1m = slot?.context_1m === "force";
  const want1m =
    suffix1m || routeForces1m || settings.force1m || headerRequests1m(requestHeaders);

  // Always send a clean (suffix-free) model id upstream: the backend id from the
  // slot, or the stripped base id for passthrough. Backends don't understand [1m].
  if (slot) {
    const target = slot.model || baseId;
    if (target && target !== modelBefore) {
      body.model = target;
      changed = true;
    }
    if (slot.upstream) route.upstream = slot.upstream.replace(/\/+$/, "");
    if (slot.auth) route.auth = slot.auth;
    if (slot.type) route.type = slot.type;
    if (slot.max_output_tokens) route.max_output_tokens = slot.max_output_tokens;
    if (slot.workspace) route.workspace = slot.workspace;
    if (slot.headers) route.headers = { ...slot.headers };
    if (slot.body) route.body = slot.body;
  } else if (modelBefore in modelMap) {
    body.model = modelMap[modelBefore];
    changed = true;
  } else if (suffix1m && baseId && baseId !== modelBefore) {
    // No slot, but the id carried [1m] — strip it for the default passthrough.
    body.model = baseId;
    changed = true;
  }

  route.want1m = want1m;

  // ---- UltraCode envelope (with per-route overrides) ----
  // A route may opt out of individual envelope fields (e.g. a strict backend
  // that rejects output_config); anything unset falls back to the global.
  const ov = slot?.envelope;
  const effEffort = ov?.effort === false ? "" : typeof ov?.effort === "string" ? ov.effort : settings.forceEffort;
  const effThinking = ov?.thinking ?? settings.forceThinking;
  const effReminder = ov?.reminder ?? settings.injectReminder;
  const effMaxFloor = typeof ov?.max_tokens === "number" ? ov.max_tokens : settings.maxTokensFloor;

  if (effEffort) {
    const oc = (body.output_config && typeof body.output_config === "object"
      ? (body.output_config as Json)
      : {}) as Json;
    if (oc.effort !== effEffort) {
      oc.effort = effEffort;
      body.output_config = oc;
      changed = true;
    }
  }

  if (effThinking) {
    const th = body.thinking;
    const thType = th && typeof th === "object" ? (th as Json).type : undefined;
    if (!(th && typeof th === "object") || (thType !== "adaptive" && thType !== "enabled")) {
      body.thinking = { type: "adaptive" };
      changed = true;
    }
  }

  const mt = body.max_tokens;
  if (typeof mt !== "number" || !Number.isInteger(mt) || mt < effMaxFloor) {
    body.max_tokens = effMaxFloor;
    changed = true;
  }

  if (effReminder && !systemHasReminder(body.system)) {
    injectReminder(body);
    changed = true;
  }

  if (changed) {
    vlog(
      `rewrote model=${modelBefore} -> ${String(body.model)} ` +
        `effort=${String((body.output_config as Json | undefined)?.effort)} ` +
        `max_tokens=${String(body.max_tokens)} want1m=${want1m}`,
    );
    return { body: Buffer.from(JSON.stringify(body), "utf-8"), route };
  }
  return { body: raw, route };
}
