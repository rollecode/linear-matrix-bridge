<center align="center" style="text-align: center;justify-content:center;">
<div align="center" style="text-align: center;justify-content:center;">

<h1>Linear to Matrix bridge</h1>

<img style="justify-content:center;text-align: center;width: 180px; height: auto;"  width="1600" height="400" alt="Linear" src="https://github.com/user-attachments/assets/8c2d5756-0e3f-432a-8a3d-1d0e8293539a" /> &nbsp; <img style="justify-content:center;text-align: center;width: 100px; height: auto;" width="1920" height="820" alt="Matrix" src="https://github.com/user-attachments/assets/8685c940-eb6d-4417-8300-6979c0ce3821" />


![Version](https://img.shields.io/badge/version-0.4.0-blue.svg?style=for-the-badge) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white) ![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white) ![Matrix](https://img.shields.io/badge/Matrix-000000?style=for-the-badge&logo=matrix&logoColor=white)

</div>
</center>

<hr>

A Matrix thread and a Linear issue become one conversation. Replies in the thread turn into comments on the issue, comments on the issue appear in the thread. It is not a notification feed: the point is that the discussion happens once, in whichever tool the person is already in. Linear integrates with Slack and Discord but not Matrix, and matrix-hookshot bridges GitHub, GitLab, JIRA and OpenProject but not Linear. This fills that gap.

<hr>

## How it behaves

| In Matrix | What happens |
| --- | --- |
| `!linear Fix the login bug` | Creates an issue in the configured team. The bot replies in a thread with the identifier and URL, and that thread is now mapped to the issue. |
| `!linear` as a reply to a message | Uses the replied-to message as the description and as the thread anchor. Without a title, the first line of that message becomes the title. |
| `!linear link MEM-42` | Maps the current thread to an issue that already exists. |
| Any message in a mapped thread | Becomes a comment on the issue, nested under the first one so the Matrix thread stays one Linear comment thread. |
| Being invited to a room | The bot joins, as long as the room passes `MATRIX_ALLOWED_ROOMS`. In an encrypted room it says it cannot read anything there. |

| In Linear | What happens |
| --- | --- |
| A comment on a mapped issue | Posted into the thread, with the Linear author's name. |
| An issue state change | A one-line note in the thread. State changes only, not every field update. |

## Where it runs

Two deployments, one codebase. The Worker's `fetch` handler is the entry point in both, so routing, token checks and loop prevention cannot drift apart.

- **Cloudflare Worker with D1.** Matrix application services are push-based and Linear webhooks are plain HTTP, so both directions are stateless request handling with no long-lived `/sync` connection and nothing to patch.
- **A plain Node server with SQLite**, for putting the bridge on the same box as Synapse. `src/server/` adapts Node's HTTP server to `Request`/`Response` and puts a D1-shaped interface over `node:sqlite`. Needs Node 22.5 or newer.

## Setup

### 1. Cloudflare

```sh
npm install
npx wrangler d1 create linear-matrix-bridge
```

Put the returned `database_id` into `wrangler.jsonc`, then apply the schema and deploy:

```sh
npm run migrate:remote
npm run deploy
```

Set the non-secret values in the `vars` block of `wrangler.jsonc`:

| Var | Meaning |
| --- | --- |
| `MATRIX_HOMESERVER_URL` | Base URL of the homeserver, no trailing slash. |
| `MATRIX_BOT_USER_ID` | Full MXID built from `sender_localpart`, for example `@linear:example.org`. |
| `MATRIX_ALLOWED_ROOMS` | Comma-separated room IDs the bridge acts in. Empty means every room it is invited to. |
| `LINEAR_TEAM_ID` | UUID of the team that `!linear <title>` creates issues in. |
| `LINEAR_AUTH_MODE` | `oauth` or `api_key`. See below. |
| `COMMAND_PREFIX` | Defaults to `!linear`. |

Then the four secrets, which never belong in `wrangler.jsonc`:

```sh
npx wrangler secret put MATRIX_AS_TOKEN
npx wrangler secret put MATRIX_HS_TOKEN
npx wrangler secret put LINEAR_TOKEN
npx wrangler secret put LINEAR_WEBHOOK_SECRET
```

### 2. Matrix

Copy `registration.example.yaml` to the homeserver as `linear-matrix-bridge.yaml`, fill in the URL and the two tokens, and reference it from `homeserver.yaml`:

```yaml
app_service_config_files:
  - /etc/matrix-synapse/linear-matrix-bridge.yaml
```

**Synapse only loads registration files at startup, so it has to be restarted** before the bridge exists:

```sh
sudo systemctl restart matrix-synapse
```

Then invite `@linear:example.org` to the room. It accepts the invite by itself.

### 3. Linear

Create the webhook in Linear's API settings pointing at `https://<your-worker>/linear/webhook`, subscribed to **Issues** and **Issue comments**. Copy its signing secret into `LINEAR_WEBHOOK_SECRET`.

For `LINEAR_TOKEN` there are two options:

- **OAuth application with `actor=app`** (preferred). Comments and issues are attributed to the bridge itself, and the Matrix sender's name rides along in Linear's `createAsUser` field, so each comment shows the person who actually wrote it. Set `LINEAR_AUTH_MODE` to `oauth` and use the access token.
- **Personal API key** as a fallback. Set `LINEAR_AUTH_MODE` to `api_key`. Linear then attributes **every bridged comment and issue to the person who owns that key**, and the Matrix sender's name is written into the comment body instead.

## Running on your own server instead

Same code, no Cloudflare account. `deploy/` holds a systemd unit and an nginx vhost to copy.

```sh
git clone git@github.com:rollecode/linear-matrix-bridge.git /opt/linear-matrix-bridge
cd /opt/linear-matrix-bridge
npm ci
npm run build
mkdir -p data
```

Configuration comes from the environment rather than `wrangler.jsonc`. Put the four secrets and the vars in `/opt/linear-matrix-bridge/.env`, mode 600:

```sh
MATRIX_HOMESERVER_URL=https://matrix.example.org
MATRIX_BOT_USER_ID=@linear:example.org
MATRIX_ALLOWED_ROOMS=
LINEAR_TEAM_ID=
LINEAR_AUTH_MODE=api_key
MATRIX_AS_TOKEN=
MATRIX_HS_TOKEN=
LINEAR_TOKEN=
LINEAR_WEBHOOK_SECRET=
```

Then install the unit and start it:

```sh
sudo cp deploy/linear-matrix-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now linear-matrix-bridge
curl -s http://127.0.0.1:5055/health
```

Migrations apply themselves at startup, tracked in a `d1_migrations` table, so there is no separate migrate step. The dedupe prune runs on a daily timer in place of the Worker's cron trigger.

The bridge binds to localhost. Synapse reaches it there, so the only thing that has to be public is the Linear webhook path, which is all `deploy/nginx.conf.example` exposes.

## Loop prevention

This is where naive bridges break, so all four cases are handled in D1 rather than in memory: a Worker instance does not survive between requests.

- The Linear comment ID of every comment the bridge creates is stored, and webhooks for those IDs are dropped.
- The Matrix event ID of every message the bridge sends is stored, and events sent by the bridge's own user are ignored.
- Appservice transactions are retried by the homeserver under the same transaction ID, so a transaction is claimed before handling and skipped if it has been seen. A claim is released again if handling throws, so a genuine failure is still retried.
- A scheduled job prunes the three dedupe tables after 30 days.

## Security

- The Linear signature is verified against the raw request body, before parsing, with a constant-time comparison. Timestamps further than a minute from local time are rejected.
- The `hs_token` is verified on every appservice request.
- Every token is a Wrangler secret.
- At most 40 events are handled per transaction, so one busy room cannot exhaust the Worker's subrequest budget. A dropped remainder is logged rather than swallowed.

## Not supported

Deliberate omissions, not oversights:

- **End-to-end encrypted rooms.** The bridge has no megolm implementation, so every message in an encrypted room arrives as ciphertext it cannot read and `!linear` does nothing. It says so on joining such a room rather than failing silently. Supporting E2EE needs MSC3202 enabled on the homeserver plus a crypto store, which rules out the Worker deployment.

- **Message edits** (`m.replace`) are ignored. Bridging them would post a duplicate comment.
- **Redactions** are ignored. Deleting the matching Linear comment on the strength of a Matrix redaction is not a trade the bridge makes on its own.
- **Attachments** are noted, not transferred. `mxc://` needs authenticated media access, so the comment records that a file was attached and names it.
- **Messages posted in a thread before it was mapped** are not backfilled. `!linear link` says so in its reply.
- **Comment edits and deletions in Linear** do not propagate back to Matrix.
- Markdown and HTML conversion covers what chat messages actually use: bold, italic, strikethrough, inline code, code blocks, links, lists and quotes. It is not a full CommonMark implementation.

## Development

```sh
npm test           # vitest, against the real workerd runtime
npm run typecheck
npm run dev
```
