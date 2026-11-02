import { DurableObject } from "cloudflare:workers";

const PORT = 3000;
// ponytail: one always-warm instance (SQLite single writer + in-container Redis/Sidekiq).
// To scale out: DATABASE_URL -> Postgres, external REDIS_URL, then raise max_instances.
const KEEP_WARM_MS = 30 * 24 * 60 * 60 * 1000;

export class DocuSeal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // A redeployed Durable Object forgets the timeout; re-arm it if the container survived.
    if (ctx.container.running) ctx.blockConcurrencyWhile(() => keepWarm(ctx.container));
  }

  async fetch(request) {
    if (!this.ctx.container.running) this.ready = undefined;
    try {
      await (this.ready ??= this.boot());
    } catch (e) {
      this.ready = undefined;
      return new Response(`DocuSeal is starting, retry shortly (${e.message})`, { status: 503, headers: { "Retry-After": "10" } });
    }
    const { method, headers, body } = request;
    return this.ctx.container
      .getTcpPort(PORT)
      .fetch(request.url.replace(/^https:/, "http:"), { method, headers, body, redirect: "manual" });
  }

  async boot() {
    const { container } = this.ctx;
    if (!container.running) {
      const env = this.env;
      container.start({
        enableInternet: true,
        env: {
          APP_URL: env.APP_URL,
          HOST: new URL(env.APP_URL).host,
          FORCE_SSL: String(env.APP_URL.startsWith("https:")),
          SECRET_KEY_BASE: env.SECRET_KEY_BASE,
          S3_ATTACHMENTS_BUCKET: env.S3_ATTACHMENTS_BUCKET,
          S3_ENDPOINT: env.S3_ENDPOINT,
          AWS_REGION: "auto",
          AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
        },
      });
      await keepWarm(container);
    }
    // Litestream restore + Rails boot + migrations can take minutes. Probe /up: "/" 302s to /setup or /sign_in.
    const port = container.getTcpPort(PORT);
    for (const deadline = Date.now() + 300_000; Date.now() < deadline; ) {
      try {
        if ((await port.fetch("http://localhost/up", { redirect: "manual" })).ok) return;
      } catch {
        if (!container.running) throw new Error("container exited during boot, check its logs");
      }
      await scheduler.wait(500);
    }
    throw new Error("not healthy after 5 minutes");
  }
}

// Losing the timeout only costs cold starts, so never let it fail a request.
const keepWarm = (container) => container.setInactivityTimeout(KEEP_WARM_MS).catch((e) => console.error("setInactivityTimeout", e));

export default {
  async fetch(request, env) {
    const headers = new Headers(request.headers);
    // DocuSeal records request.remote_ip in signing audit trails; overwrite so clients can't spoof it.
    headers.set("X-Forwarded-For", request.headers.get("CF-Connecting-IP") ?? "");
    headers.set("X-Forwarded-Proto", new URL(request.url).protocol.slice(0, -1));
    return env.DOCUSEAL.getByName("main").fetch(new Request(request, { headers }));
  },
};
