/** Unit tests for Anthropic⇄OpenAI translation (tools both ways, adjacency). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { anthropicToOpenai, textFromAnthropicContent } from "../../src/pipeline/translate.js";

const assistantCalls = (...ids: string[]) => ({
  role: "assistant",
  content: [{ type: "text", text: "ok" }, ...ids.map((i) => ({ type: "tool_use", id: i, name: "t", input: {} }))],
});

/** Assert every assistant.tool_calls turn is followed by one tool msg per id, in order. */
function assertAdjacency(msgs: any[]): void {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].tool_calls) {
      const need = msgs[i].tool_calls.map((t: any) => t.id);
      const got: string[] = [];
      let j = i + 1;
      while (j < msgs.length && msgs[j].role === "tool") got.push(msgs[j++].tool_call_id);
      assert.deepEqual(got, need);
    }
  }
}

test("textFromAnthropicContent flattens strings, text + tool_result blocks", () => {
  assert.equal(textFromAnthropicContent("hi"), "hi");
  assert.equal(
    textFromAnthropicContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assert.equal(textFromAnthropicContent([{ type: "tool_result", content: "r" }]), "r");
  assert.equal(textFromAnthropicContent([{ type: "image" }]), "[image omitted]");
});

test("system string and system blocks both become a system message", () => {
  assert.equal(anthropicToOpenai({ model: "m", system: "S", messages: [] }).messages[0]!.content, "S");
  assert.equal(anthropicToOpenai({ model: "m", system: [{ type: "text", text: "S2" }], messages: [] }).messages[0]!.content, "S2");
});

test("tools and tool_choice translate to OpenAI shape", () => {
  const out = anthropicToOpenai({
    model: "m",
    tools: [{ name: "t", description: "d", input_schema: { type: "object", properties: {} } }],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: "go" }],
  });
  assert.equal(out.tools![0]!.function.name, "t");
  assert.equal(out.tool_choice, "required", "any → required");
  const forced = anthropicToOpenai({ model: "m", tools: [{ name: "t" }], tool_choice: { type: "tool", name: "t" }, messages: [] });
  assert.deepEqual(forced.tool_choice, { type: "function", function: { name: "t" } }, "tool → function-by-name");
});

test("rejected tool call: reply synthesized first, user comment after, adjacency holds", () => {
  const m = anthropicToOpenai({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      assistantCalls("call_1"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "rejected" },
          { type: "text", text: "no" },
        ],
      },
    ],
  }).messages;
  assertAdjacency(m);
  assert.deepEqual(m[m.length - 1], { role: "user", content: "no" });
});

test("partial tool replies: a stub is synthesized for the unanswered id", () => {
  const m = anthropicToOpenai({
    model: "m",
    messages: [
      { role: "user", content: "go" },
      assistantCalls("call_1", "call_2"),
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
    ],
  }).messages;
  assertAdjacency(m);
  assert.deepEqual(
    m.filter((x: any) => x.role === "tool").map((x: any) => x.tool_call_id),
    ["call_1", "call_2"],
  );
});

test("max_tokens and temperature pass through when present", () => {
  const out = anthropicToOpenai({ model: "m", max_tokens: 123, temperature: 0.4, messages: [] });
  assert.equal(out.max_tokens, 123);
  assert.equal(out.temperature, 0.4);
  assert.equal(out.stream, false);
});
