# Environment

Copy `.env.example` to `.env` in the repository root and fill in the values:

```bash
cp .env.example .env          # macOS / Linux
Copy-Item .env.example .env   # Windows PowerShell
```

The API validates its configuration when it starts and refuses to run with a
precise list of anything missing or malformed, so a half-configured process never
reaches a participant. Every variable below is read by code in `server/src` or
`client/src`; none is decorative.

Two rules matter more than the rest:

- **Only the four `VITE_*` variables reach the browser.** Everything else is
  server-only and must never be prefixed `VITE_`.
- **`CLIENT_URL` must be the address a buyer will actually open** before you print
  a QR code for real produce. It is baked into the verification link on the label.

`npm run audit:env` checks this file against the code that reads it and fails if a
variable is documented but unread, read but undocumented, or — the one that
matters — if a server-only secret has been exposed to the browser.

## Application

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production`. |
| `PORT` | `4000` | Where the API listens. |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. |
| `API_BASE_URL` | `http://localhost:4000` | This API's absolute URL. Appears in log lines and in printed reports. |
| `CLIENT_URL` | `http://localhost:5173` | The interface's absolute URL. Baked into verification links. |

## Database

| Variable | Default | Notes |
| --- | --- | --- |
| `MONGODB_URI` | — | **Required.** Connection string, credentials included. Server-only. |
| `MONGODB_DB_NAME` | `agri_trace` | Database name. |
| `MONGODB_MAX_POOL_SIZE` | `10` | Connection pool ceiling. |

`MONGODB_URI` frequently carries a password. It is server-only, and
`audit:env` fails if it is ever exposed to the browser.

Test suites start their own in-memory MongoDB, so they need none of this.

## Solana

| Variable | Default | Notes |
| --- | --- | --- |
| `SOLANA_NETWORK` | `devnet` | `devnet`, `testnet` or `mainnet-beta`. |
| `SOLANA_RPC_URL` | — | **Required.** JSON RPC endpoint. May carry an API key, so it is server-only. |
| `SOLANA_WS_URL` | — | WebSocket endpoint, for subscriptions. |
| `SOLANA_PROGRAM_ID` | — | **Required.** The deployed program's address. |
| `SOLANA_COMMITMENT` | `confirmed` | What a write waits for. Use `finalized` in production. |
| `SOLANA_PREFETCH_COMMITMENT` | `confirmed` | What a read waits for. Can be cheaper than a write's. |
| `SOLANA_TX_TIMEOUT_MS` | `30000` | How long to wait before reporting a write unresolved. |
| `SOLANA_RETRY_ATTEMPTS` | `3` | Retries for a transient RPC failure. |

The public `VITE_SOLANA_RPC_URL` is a separate, key-free read-only endpoint, for
the rare case the interface needs the chain directly. The signed endpoint stays on
the server.

## Sessions and cookies

| Variable | Default | Notes |
| --- | --- | --- |
| `SESSION_SECRET` | — | **Required.** At least 32 characters. Server-only, and the most important secret here. |
| `AUTH_NONCE_TTL_SECONDS` | `300` | How long a sign-in nonce stays valid. |
| `SESSION_TTL_SECONDS` | `86400` | How long a session lasts. |
| `COOKIE_SECURE` | `false` in dev | Must be `true` behind HTTPS. |
| `COOKIE_SAME_SITE` | `lax` | `lax`, `strict` or `none`. |
| `COOKIE_DOMAIN` | unset | Set only when the API and interface are on different subdomains. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy, so client IPs are read correctly. |

`SESSION_SECRET` signs the session cookie's digest. **Rotating it invalidates every
outstanding session**, which is the intended way to force a mass sign-out after a
possible compromise. There is no data migration to undo.

Setting `COOKIE_SECURE=false` in production would send session cookies over plain
HTTP. The API refuses to start with that combination outside development.

## Uploads

| Variable | Default | Notes |
| --- | --- | --- |
| `UPLOAD_MAX_FILE_BYTES` | `10485760` | 10 MiB per file. |
| `UPLOAD_MAX_FILES_PER_REQUEST` | `5` | Files per request. |

Files are stored in GridFS and hashed on the way in. The limits are enforced by
the API rather than trusted from the client.

## Rate limits

| Variable | Default | Notes |
| --- | --- | --- |
| `RATE_LIMIT_WINDOW_MS` | `60000` | The window all budgets share. |
| `RATE_LIMIT_MAX_AUTHENTICATED` | `300` | Reads by a signed-in participant. |
| `RATE_LIMIT_MAX_PUBLIC` | `120` | Anonymous reads, including verification. |
| `RATE_LIMIT_MAX_AUTH_ATTEMPTS` | `10` | Sign-in attempts per address. |
| `RATE_LIMIT_MAX_UPLOADS` | `20` | Uploads per window. |

The budgets are separate on purpose. A burst of anonymous verification — a popular
batch being checked by buyers — must not lock a farmer out of their own batches.

## Operations

| Variable | Default | Notes |
| --- | --- | --- |
| `RECONCILIATION_ENABLED` | `true` | Whether chain and database differences are recorded for review. |

## Browser-visible

These four are compiled into the client bundle and are public by construction.
None may be a secret.

| Variable | Notes |
| --- | --- |
| `VITE_API_BASE_URL` | Where the interface sends its requests. |
| `VITE_SOLANA_NETWORK` | Displayed so a participant knows which chain they are on. |
| `VITE_SOLANA_RPC_URL` | A read-only, key-free endpoint, if the interface needs one. |
| `VITE_SOLANA_PROGRAM_ID` | Displayed on verification screens so a reader can check the address themselves. |

## Generating a session secret

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

## Minimum for a devnet run

```bash
NODE_ENV=development
PORT=4000
API_BASE_URL=http://localhost:4000
CLIENT_URL=http://localhost:5173
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB_NAME=agri_trace
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_PROGRAM_ID=CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm
SESSION_SECRET=<at least 32 characters>
VITE_API_BASE_URL=http://localhost:4000
VITE_SOLANA_NETWORK=devnet
VITE_SOLANA_PROGRAM_ID=CTKBH9KnbTd8zL4sHNpj4CBPPQcHu2uZk613WpA1ZiDm
```

## Before production

- `COOKIE_SECURE=true`, and TLS terminated in front of both services.
- `NODE_ENV=production`.
- `SOLANA_COMMITMENT=finalized`.
- A dedicated database user with only the privileges the API needs.
- A real `SESSION_SECRET` from the generator above, never a placeholder.
- `CLIENT_URL` and `CORS_ORIGINS` set to the real hostnames.
- `TRUST_PROXY=true` if anything sits in front of the API.
- RPC credentials confined to `SOLANA_RPC_URL`, which is server-only.
