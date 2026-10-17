// Ring Partner API: the calls CareBell makes, and webhook verification.
// Docs: https://developer.amazon.com/docs/ring/api-documentation.html

import { createHmac, timingSafeEqual } from "node:crypto";

export const RING_API = "https://api.amazonvision.com";

/** A Ring webhook, v1.1 (motion_detected, button_press, device_online, ...). */
export interface RingWebhook {
  meta: { version: string; time: string; request_id: string; account_id: string };
  data: {
    id: string;
    type: string;
    attributes: { source: string; source_type: string; timestamp: number; sub_type?: string; component_ids?: string[] };
    relationships?: Record<string, unknown>;
  };
}

/** HMAC-SHA256 over the raw body, hex, in `X-Signature: sha256=<hex>`. Verify first, parse second. */
export function sign(key: string, rawBody: string | Buffer): string {
  return "sha256=" + createHmac("sha256", key).update(rawBody).digest("hex");
}

export function verify(key: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;
  const want = Buffer.from(sign(key, rawBody).slice(7), "hex");
  const got = Buffer.from(header.replace(/^sha256=/, ""), "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Checks the shape we rely on; anything else is a 400 (Ring does not retry 4xx). */
export function parseWebhook(raw: Buffer): RingWebhook {
  const p = JSON.parse(raw.toString("utf8"));
  if (!p?.meta?.request_id || !p?.data?.type || !p?.data?.attributes?.source || typeof p.data.attributes.timestamp !== "number")
    throw new Error("not a Ring v1.1 webhook");
  return p as RingWebhook;
}

export interface Device { id: string; name: string; online?: boolean; imageUrl?: string }
export interface HistoryEvent { id: string; type: string; subType?: string; timestamp: number; deviceId: string }

/** A thin client for the partner API. `token` returns a current access token (Playground token or OAuth). */
export class RingClient {
  token: () => Promise<string>;
  base: string;
  fetchFn: typeof fetch;
  constructor(token: () => Promise<string>, base = RING_API, fetchFn: typeof fetch = fetch) {
    this.token = token;
    this.base = base;
    this.fetchFn = fetchFn;
  }

  private async get(path: string): Promise<any> {
    const r = await this.fetchFn(this.base + path, { headers: { Authorization: `Bearer ${await this.token()}` } });
    if (!r.ok) throw new RingError(r.status, await r.text());
    return r.json();
  }

  async devices(): Promise<Device[]> {
    const j = await this.get("/v1/devices");
    return j.data.map((d: any) => ({ id: d.id, name: d.attributes?.name ?? "Ring device", imageUrl: d.attributes?.image_url }));
  }

  async online(deviceId: string): Promise<boolean> {
    const j = await this.get(`/v1/devices/${encodeURIComponent(deviceId)}/status`);
    return !!j.data?.attributes?.online;
  }

  async capabilities(deviceId: string): Promise<any> {
    return (await this.get(`/v1/devices/${encodeURIComponent(deviceId)}/capabilities`)).data?.attributes;
  }

  /**
   * Event history: the polling alternative to webhooks. A real device returns
   * `{ type: "history-events", attributes: { event_type: "ding" | "motion" | "on_demand", start, end } }`.
   */
  async history(deviceId: string, limit = 20): Promise<HistoryEvent[]> {
    const j = await this.get(`/v1/history/devices/${encodeURIComponent(deviceId)}/events?limit=${limit}`);
    return (j.data ?? []).map((e: any) => ({
      id: e.id,
      type: e.attributes?.event_type ?? e.type,
      subType: e.attributes?.sub_type,
      timestamp: e.attributes?.start ?? e.attributes?.timestamp ?? Date.parse(e.attributes?.created_at ?? ""),
      deviceId,
    }));
  }

  /**
   * A JPEG from the door at `timestamp`: POST → 303 → pre-signed GET. The redirect is followed by hand so the
   * Ring token never goes to the storage host. Null while Ring has no media for that moment yet (416).
   */
  async snapshot(deviceId: string, timestamp: number): Promise<Buffer | null> {
    const r = await this.fetchFn(`${this.base}/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
      method: "POST",
      redirect: "manual",
      headers: { Authorization: `Bearer ${await this.token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "at_timestamp", timestamp, image_options: { format: "jpeg", resolution: { width: 640, height: 360 } } }),
    });
    const loc = r.headers.get("location");
    if (r.status !== 303 || !loc) {
      if (r.status >= 500 || r.status === 401) throw new RingError(r.status, await r.text());
      return null;
    }
    const g = await this.fetchFn(loc);
    if (!g.ok) return null;
    return Buffer.from(await g.arrayBuffer());
  }
}

export class RingError extends Error {
  status: number;
  constructor(status: number, body: string) {
    super(`Ring API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}
