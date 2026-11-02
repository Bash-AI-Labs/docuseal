// Creates or updates the Cloudflare Access apps that gate DocuSeal. Safe to re-run.
// CLOUDFLARE_API_TOKEN=... ACCESS_ADMINS=a@bashai.com,b@bashai.com node access.mjs
// Token permissions: Access: Apps and Policies Edit, Access: Organizations, Identity Providers, and Groups Edit,
// Workers Scripts Read. Zero Trust must already be set up on the account (it owns the login page).
import { fileURLToPath } from "node:url";

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? "cf3c0ad1f027a8b13d751506e23c73a2";
const WORKER = "bashai-docuseal";

// Signer-facing routes from config/routes.rb, plus assets and the X-Auth-Token API. Re-check when upgrading DocuSeal.
const PUBLIC_PATHS = ["/s/*", "/d/*", "/p/*", "/e/*", "/success", "/submit_form_email_2fa", "/start_form_email_2fa_send",
  "/resubmit_form", "/start_form_self/*", "/send_submission_email", "/submitters/*", "/file/*", "/blobs_proxy/*",
  "/preview/*", "/rails/active_storage/*", "/packs/*", "/fonts/*", "/api/*", "/js/*", "/up", "/favicon*"];

async function setupAccess(cf, accountId, worker, admins, host) {
  const A = `/accounts/${accountId}/access`;
  const org = await cf("GET", `${A}/organizations`);
  host ??= `${worker}.${(await cf("GET", `/accounts/${accountId}/workers/subdomain`)).subdomain}.workers.dev`;
  const idps = await cf("GET", `${A}/identity_providers`);
  const otp = idps.find((i) => i.type === "onetimepin")
    ?? await cf("POST", `${A}/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} });
  const upsert = async (kind, body) => {
    const found = (await cf("GET", `${A}/${kind}`)).find((x) => x.name === body.name);
    return found ? cf("PUT", `${A}/${kind}/${found.id}`, body) : cf("POST", `${A}/${kind}`, body);
  };
  const admin = await upsert("policies", { name: "BashAI DocuSeal admins", decision: "allow",
    include: admins.map((email) => ({ email: { email } })), session_duration: "24h" });
  const everyone = await upsert("policies", { name: "BashAI DocuSeal public signer links", decision: "bypass",
    include: [{ everyone: {} }] });
  await upsert("apps", { name: "BashAI DocuSeal", type: "self_hosted", domain: host,
    destinations: [{ type: "public", uri: host }], allowed_idps: [otp.id], auto_redirect_to_identity: true,
    session_duration: "24h", app_launcher_visible: true, policies: [{ id: admin.id, precedence: 1 }] });
  // More specific than the app above, so it wins for these paths.
  await upsert("apps", { name: "BashAI DocuSeal - public signer links", type: "self_hosted", domain: host + PUBLIC_PATHS[0],
    destinations: PUBLIC_PATHS.map((p) => ({ type: "public", uri: host + p })), app_launcher_visible: false,
    policies: [{ id: everyone.id, precedence: 1 }] });
  return { login: org.auth_domain, host, admins };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cf = async (method, path, body) => {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.success) throw new Error(`${method} ${path}: ${JSON.stringify(json.errors)}`);
    return json.result;
  };
  const admins = (process.env.ACCESS_ADMINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!admins.length) throw new Error("Set ACCESS_ADMINS to the comma-separated emails allowed into the admin UI");
  console.log(await setupAccess(cf, ACCOUNT_ID, WORKER, admins, process.env.HOST));
}
