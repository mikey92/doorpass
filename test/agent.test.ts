import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, type Mcp } from "../src/agent.ts";

const TOOLS = [
  { name: "who_is_at_door", description: "who rang", inputSchema: { type: "object", properties: {} } },
  { name: "let_them_in", description: "open", inputSchema: { type: "object", properties: {} } },
  { name: "keep_door_closed", description: "refuse", inputSchema: { type: "object", properties: {} } },
];
function fakeMcp(calls: string[]): Mcp {
  return async (method, params: any) => {
    if (method === "tools/list") return { tools: TOOLS };
    calls.push(params.name);
    return { content: [{ type: "text", text: params.name === "who_is_at_door" ? "Someone rang 20 seconds ago. No booking." : "Opened." }] };
  };
}
const toolTurn = (name: string) => ({ stopReason: "tool_use", output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name, input: {} } }] } } });
const textTurn = (text: string) => ({ stopReason: "end_turn", output: { message: { role: "assistant", content: [{ text }] } } });

test("agent: the model calls a DoorPass tool, then answers with what it returned", async () => {
  const calls: string[] = [];
  const bodies: any[] = [];
  const turns = [toolTurn("who_is_at_door"), textTurn("<thinking>check</thinking>Someone without a booking rang just now.")];
  const a = await ask("who's at the door?", fakeMcp(calls), async (b) => (bodies.push(structuredClone(b)), turns.shift()), { canWrite: true });
  assert.deepEqual(calls, ["who_is_at_door"]);
  assert.equal(a.text, "Someone without a booking rang just now.");
  assert.equal(a.steps[0].result, "Someone rang 20 seconds ago. No booking.");
  assert.equal(bodies[1].messages.at(-1).content[0].toolResult.content[0].text, "Someone rang 20 seconds ago. No booking.");
});

test("agent: without the manager key the door tools aren't offered, and a forced call is refused", async () => {
  const calls: string[] = [];
  let offered: string[] = [];
  const turns = [toolTurn("let_them_in"), textTurn("Only the manager can open the door.")];
  const a = await ask("let them in", fakeMcp(calls), async (b: any) => ((offered = b.toolConfig.tools.map((t: any) => t.toolSpec.name)), turns.shift()), { canWrite: false });
  assert.deepEqual(offered, ["who_is_at_door"]);
  assert.deepEqual(calls, [], "let_them_in never reached the MCP server");
  assert.equal(a.steps[0].result, "That action needs the manager.");
});

test("describeVisitor: sends the Ring JPEG to the model and keeps one sentence", async () => {
  const { describeVisitor } = await import("../src/agent.ts");
  let sent: any;
  const note = await describeVisitor(async (b: any) => ((sent = b), { output: { message: { content: [{ text: "One person holding a guitar case. They look toward the camera." }] } } }), Buffer.from([0xff, 0xd8]));
  assert.equal(note, "One person holding a guitar case.");
  assert.equal(sent.messages[0].content[0].image.format, "jpeg");
  assert.equal(sent.messages[0].content[0].image.source.bytes, Buffer.from([0xff, 0xd8]).toString("base64"));
});
