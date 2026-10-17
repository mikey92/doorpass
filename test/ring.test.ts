import { test } from "node:test";
import assert from "node:assert/strict";
import { RingClient } from "../src/ring.ts";

test("snapshot: POST, then the pre-signed URL without the Ring token; 416 means not ready yet", async () => {
  const calls: { url: string; auth?: string }[] = [];
  let ready = false;
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    if (String(url).includes("/media/image/download")) return ready ? new Response(null, { status: 303, headers: { location: "https://media.example/x.jpg?sig=1" } }) : new Response("{}", { status: 416 });
    return new Response(new Uint8Array([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  const ring = new RingClient(async () => "secret-token", "https://api.example", fake);
  assert.equal(await ring.snapshot("dev1", 1000), null);
  ready = true;
  const jpg = await ring.snapshot("dev1", 1000);
  assert.equal(jpg?.length, 3);
  assert.equal(calls.at(-2)!.auth, "Bearer secret-token");
  assert.equal(calls.at(-1)!.url, "https://media.example/x.jpg?sig=1");
  assert.equal(calls.at(-1)!.auth, undefined, "the token never goes to the storage host");
});
