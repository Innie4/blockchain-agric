# Deployment

The application is three deployable things: an API, an interface, and a database.
The API and the interface are built by this repository; the database is a service
you provision.

Nothing in this document is a secret, and no connection string, API key or
keypair belongs in this repository. Every credential is set as an environment
variable on the service that uses it.

## What has to exist before the API will start

The API validates its configuration on start and refuses to run with a list of
what is missing or wrong, rather than serving half-configured. In production four
things must be true, and only one of them is about this codebase:

| Requirement | Where it is set |
| --- | --- |
| A **hosted MongoDB**, with its connection string in `MONGODB_URI` | Service environment variables |
| `COOKIE_SECURE=true`, because production traffic is HTTPS | Service environment variables |
| `SESSION_SECRET`, at least 32 characters, generated per deployment | Service environment variables |
| `SOLANA_PROGRAM_ID`, the address of the program that is actually deployed | Service environment variables |

A hosted platform runs the API in a container. **There is no MongoDB running
beside it**, so `MONGODB_URI` cannot point at `localhost`. The API warns at start
when it does, and then fails to connect.

## The database

MongoDB Atlas has a free tier and is the least fiddly option. Create a free
cluster, add a database user, and allow access from wherever the API runs. Then
take the connection string and set it as `MONGODB_URI` on the service.

For a connection string to a replica set such as Atlas, add the options the
driver needs:

```
mongodb+srv://USER:PASSWORD@HOST/?retryWrites=true&w=majority
```

The API already sets `retryWrites` itself, so the query string is only needed
when the driver cannot infer it from the host.

The database name is separate: `MONGODB_DB_NAME`, defaulting to `agri_trace`.
Give each environment its own database, so a staging deployment cannot see
production batches.

## The API

A Node service, built and started from the repository.

- **Build command:** `npm run build`
- **Start command:** `npm start`
- **Health check path:** `/api/health`

The build compiles the API and then bundles the interface. Both need the
compiler and the type packages, which are devDependencies; `.npmrc` sets
`include=dev` so a platform that builds with `NODE_ENV=production` still
installs them. Without that file the build fails on every route with
`TS7016: Could not find a declaration file for module 'express'`.

Required environment variables:

| Variable | Notes |
| --- | --- |
| `NODE_ENV` | `production`. |
| `MONGODB_URI` | A **hosted** database. Not `localhost`. |
| `MONGODB_DB_NAME` | One database per environment. |
| `SESSION_SECRET` | Generated per deployment. Rotating it signs everyone out. |
| `COOKIE_SECURE` | `true`. The API refuses to start in production without it. |
| `API_BASE_URL` | The API's own public URL. Appears in reports and log lines. |
| `CLIENT_URL` | The interface's public URL. Baked into verification links. |
| `CORS_ORIGINS` | The interface's URL, so the browser may call the API. |
| `SOLANA_NETWORK` | `mainnet-beta`, `devnet` or `testnet`. |
| `SOLANA_RPC_URL` | A mainnet endpoint. Keep any API key server-side. |
| `SOLANA_WS_URL` | A websocket endpoint. |
| `SOLANA_PROGRAM_ID` | The deployed program. A placeholder is refused at start. |
| `SOLANA_COMMITMENT` | `finalized` for mainnet. |
| `TRUST_PROXY` | `true` when a proxy or load balancer sits in front. |

Do not set `PORT`: the platform assigns it, and the API reads it from the
environment.

## The interface

A static build. Any static host will do.

- **Build command:** `npm run build --workspace @agri-trace/client`
- **Publish directory:** `client/dist`
- **Framework preset:** Vite

The four `VITE_*` variables are compiled into the bundle and are public by
construction. None may be a secret.

| Variable | Notes |
| --- | --- |
| `VITE_API_BASE_URL` | The API's public URL. |
| `VITE_SOLANA_NETWORK` | Shown to participants so they know which chain. |
| `VITE_SOLANA_PROGRAM_ID` | Shown on verification screens. |
| `VITE_SOLANA_RPC_URL` | A read-only, key-free endpoint, if one is needed. |

These are read **at build time**. Changing one means rebuilding, not restarting.

## The program

The program must be built and deployed before the API can write to a chain.

```bash
anchor build
anchor deploy --provider.cluster mainnet-beta
```

`anchor deploy` needs:

- a **program keypair**, held outside the repository. It is the program's
  identity: whoever holds it can upgrade the program, and whoever loses it can
  never upgrade or close it again. Back it up.
- a **funded deploy wallet**, since a mainnet program account needs rent-exempt
  SOL before it will hold code.

The address that keypair produces is what `SOLANA_PROGRAM_ID` and
`declare_id!` must both say. If they disagree, the backend derives addresses
from a different program than the one it is talking to, which fails in a way
that looks like data loss rather than a configuration mistake.

Deploy to devnet first. A program that has never executed on any validator can
fail in ways a compiler cannot predict, and on mainnet that is not reversible.

## Verifying a deployment

Once it starts:

```bash
curl -fsS "$API/api/health"          # the process is up
curl -fsS "$API/api/health/ready"    # the database and the chain are reachable
curl -fsS "$API/api/config"          # which network and program it is running
```

`/api/config` reports no secret: no session secret, no database URI, no RPC key.
It is safe to read in front of anyone.

Then open the interface and check a batch that does not exist. The public
verification page should say no batch is registered under that identifier, which
means the request reached the API, the API reached the chain, and the page
rendered. That path needs no account and no deployed program, so it distinguishes
a working deployment from one that merely starts.

## Checklist

- [ ] Hosted database created, and `MONGODB_URI` set on the service
- [ ] `MONGODB_DB_NAME` is not the development name
- [ ] `SESSION_SECRET` generated fresh, not copied from anywhere
- [ ] `COOKIE_SECURE=true` and the site served over HTTPS
- [ ] `CORS_ORIGINS` is the interface's real URL
- [ ] `API_BASE_URL` and `CLIENT_URL` are the real public URLs
- [ ] `TRUST_PROXY=true` if anything is in front of the API
- [ ] Program built and deployed; `SOLANA_PROGRAM_ID` matches `declare_id!`
- [ ] `SOLANA_COMMITMENT=finalized` on mainnet
- [ ] Program keypair backed up, and stored outside the repository
- [ ] RPC key confined to `SOLANA_RPC_URL`, which is server-side only
