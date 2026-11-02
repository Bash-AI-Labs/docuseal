# BashAI DocuSeal on Cloudflare

Runs this fork on Cloudflare: a Worker fronts one [Container](https://developers.cloudflare.com/containers/)
running the DocuSeal image, R2 holds every byte that must survive a restart, and Cloudflare Access gates the admin UI.

```
browser ──► Access (bashai.cloudflareaccess.com) ──► Worker ──► Durable Object ──► Container :3000
                                                                                    ├─ DocuSeal (Puma + Sidekiq + Redis)
                                                                                    └─ Litestream ──► R2 bashai-docuseal/litestream/db
                                                     ActiveStorage attachments ──► R2 bashai-docuseal/<key>
```

- **Database**: SQLite at `/data/docuseal/db.sqlite3`, restored from R2 on boot and streamed back every second by
  [Litestream](https://litestream.io) (final sync on SIGTERM). Container disk is ephemeral, so nothing else on it matters.
- **Files**: DocuSeal's S3 storage (`S3_ATTACHMENTS_BUCKET` + `S3_ENDPOINT`) pointed at R2.
- **Auth**: DocuSeal's own login (Devise, optional 2FA) behind Cloudflare Access email OTP. Signer links stay public.
- **Single instance**: `max_instances: 1`, kept warm for 30 days of inactivity. SQLite allows one writer, and
  Sidekiq's queue lives in in-container Redis. To scale out, move to `DATABASE_URL` (Postgres) and `REDIS_URL` first.

## One-time setup

1. Account prerequisites: Workers Paid plan (Containers) and R2 enabled.
2. `npx wrangler r2 bucket create bashai-docuseal`
3. R2 → Manage API tokens → **Object Read & Write** scoped to `bashai-docuseal`, then:
   ```sh
   npx wrangler secret put AWS_ACCESS_KEY_ID      # R2 Access Key ID
   npx wrangler secret put AWS_SECRET_ACCESS_KEY  # R2 Secret Access Key
   openssl rand -hex 64 | npx wrangler secret put SECRET_KEY_BASE
   ```
   `SECRET_KEY_BASE` encrypts stored credentials and signing certificates: never rotate it casually.
4. `npm install && npm run deploy` (Docker must be running; the image builds for `linux/amd64`).
5. Open the app, pass Access, and complete DocuSeal's `/setup` to create the first admin.

## Access

Two self-hosted Access apps on `bashai-docuseal.charlesnapster65.workers.dev`; the more specific path app wins:

| App | Destinations | Policy |
| --- | --- | --- |
| BashAI DocuSeal | whole hostname | Allow: `BashAI DocuSeal admins` (email OTP) |
| BashAI DocuSeal - public signer links | `/s/*` `/d/*` `/p/*` `/e/*` `/success` `/submit_form_email_2fa` `/start_form_email_2fa_send` `/resubmit_form` `/start_form_self/*` `/send_submission_email` `/submitters/*` `/file/*` `/blobs_proxy/*` `/preview/*` `/rails/active_storage/*` `/packs/*` `/fonts/*` `/api/*` `/js/*` `/up` `/favicon*` | Bypass: everyone |

Add teammates to the `BashAI DocuSeal admins` policy and invite them in DocuSeal (Settings → Users).
The bypass list mirrors DocuSeal's signer routes in `config/routes.rb`; re-check it when upgrading DocuSeal.
`/api/*` stays public because DocuSeal's API authenticates with `X-Auth-Token`.

## Operations

- Logs: `npx wrangler tail`, or Workers & Pages → bashai-docuseal → Containers.
- Upgrade DocuSeal: bump the `FROM docuseal/docuseal:<version>` tag and redeploy. The rollout stops the old container
  (Litestream syncs on SIGTERM) before starting the new one, then migrations run on boot.
- Point-in-time copy of the DB (uses `litestream.yml` from the image; `-timestamp` for older points):
  ```sh
  docker run --rm -v "$PWD:/out" -e S3_ATTACHMENTS_BUCKET=bashai-docuseal \
    -e S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
    <image> litestream restore -o /out/db.sqlite3 /data/docuseal/db.sqlite3
  ```
- Local dev: copy secrets into `.dev.vars` (`APP_URL=http://localhost:8787`, any S3-compatible endpoint) and `npm run dev`.
