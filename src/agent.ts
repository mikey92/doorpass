// The Alexa+ brain: free speech in, the DoorPass MCP tools out. Amazon Bedrock's Converse API picks the
// tools (who_is_at_door, let_them_in, ...) and DoorPass's own MCP server runs them, so the agent can do
// exactly what the manager's Alexa can do and nothing else.

export type Mcp = (method: string, params?: unknown) => Promise<any>;
export type Converse = (body: unknown) => Promise<any>;

export const MODEL = process.env.BEDROCK_MODEL ?? "us.amazon.nova-pro-v1:0";
const REGION = process.env.BEDROCK_REGION ?? "us-east-1";

const SYSTEM = `You are Alexa, answering the manager of a small unstaffed space about its front door, through DoorPass.
Use the tools for every fact. A booking only says who is expected; never say a named person is at the door unless their pass was tapped.
Only call let_them_in when the manager clearly asks to open the door or let someone in. If they are unsure, say what you know and ask.
Reply in one or two short spoken sentences, no lists, no markdown.`;

/** Bedrock Converse over HTTPS with a Bedrock API key (Bearer). No SDK. */
export function bedrock(apiKey: string, model = MODEL, region = REGION, fetchFn: typeof fetch = fetch): Converse {
  return async (body) => {
    const r = await fetchFn(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Bedrock ${r.status}: ${String(j.message ?? "").slice(0, 160)}`);
    return j;
  };
}

export interface Step { tool: string; input: unknown; result: string }
export interface Answer { text: string; steps: Step[]; ms: number; model: string }

/** One spoken request → tool calls → spoken answer. `canWrite` false hides the tools that open or refuse the door. */
export async function ask(said: string, mcp: Mcp, converse: Converse, opts: { canWrite: boolean; model?: string; maxTurns?: number }): Promise<Answer> {
  const t0 = Date.now();
  const listed = (await mcp("tools/list", {})).tools as { name: string; description?: string; inputSchema?: unknown }[];
  const WRITE = new Set(["let_them_in", "keep_door_closed"]);
  const tools = listed
    .filter((t) => opts.canWrite || !WRITE.has(t.name))
    .map((t) => ({ toolSpec: { name: t.name, description: t.description ?? t.name, inputSchema: { json: t.inputSchema ?? { type: "object", properties: {} } } } }));
  const messages: any[] = [{ role: "user", content: [{ text: said }] }];
  const steps: Step[] = [];
  for (let turn = 0; turn < (opts.maxTurns ?? 5); turn++) {
    const res = await converse({ system: [{ text: SYSTEM }], messages, toolConfig: { tools }, inferenceConfig: { maxTokens: 300, temperature: 0.2 } });
    const msg = res.output?.message;
    if (!msg) throw new Error("Bedrock returned no message");
    messages.push(msg);
    const uses = (msg.content ?? []).filter((c: any) => c.toolUse).map((c: any) => c.toolUse);
    if (res.stopReason !== "tool_use" || !uses.length) {
      const text = (msg.content ?? []).map((c: any) => c.text ?? "").join(" ").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
      return { text: text || "Sorry, I didn't get that.", steps, ms: Date.now() - t0, model: opts.model ?? MODEL };
    }
    const results = [];
    for (const u of uses) {
      let out: string;
      let status: "success" | "error" = "success";
      if (!tools.some((t) => t.toolSpec.name === u.name)) {
        out = "That action needs the manager.";
        status = "error";
      } else {
        try {
          const r = await mcp("tools/call", { name: u.name, arguments: u.input ?? {} });
          out = (r.content ?? []).map((c: any) => c.text ?? "").join(" ");
          if (r.isError) status = "error";
        } catch (e) {
          out = (e as Error).message;
          status = "error";
        }
      }
      steps.push({ tool: u.name, input: u.input ?? {}, result: out });
      results.push({ toolResult: { toolUseId: u.toolUseId, content: [{ text: out }], status } });
    }
    messages.push({ role: "user", content: results });
  }
  return { text: "Sorry, that took too many steps.", steps, ms: Date.now() - t0, model: opts.model ?? MODEL };
}
