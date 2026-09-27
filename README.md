# AgriTrace

A blockchain-based decentralised ecosystem for transparent agricultural supply
chain management.

A farmer registers a batch of produce, records a fingerprint of its details on
Solana, and hands it on. Every later holder records what they did to it, and every
handover is a signed, confirmed transaction. Any member of the public can check a
batch from its identifier alone — no account, no wallet, no sign-in — and see
whether the stored details still produce the fingerprint that was anchored when
the batch was registered, together with the whole journey it has taken.

The point of the system is that a claim about a product can be checked against
something the claimant cannot quietly edit. If the details held for a batch have
changed since registration, the public check says so.

## Repository layout

| Path | What it is |
| --- | --- |
| `programs/agri_trace` | The Anchor program: the participant registry, product accounts, and the rules that govern them. |
| `server` | The API. Holds no private keys. Owns hashing, storage, sessions, reporting, and the two-phase blockchain flow. |
| `client` | The interface. React, no wallet custody, Phantom through the standard wallet interface. |
| `tests/e2e` | Browser flows driven through the real interface against the real API. |
| `scripts` | Repository-wide audits, run in CI and before a release. |
| `docs` | Architecture, API, blockchain, environment, and testing notes. |

Documentation:

- [Architecture](docs/architecture.md) — how the pieces fit, and why.
- [API](docs/api.md) — every route, what it needs, and what it returns.
- [Blockchain](docs/blockchain.md) — the program, the accounts, and the two-phase write flow.
- [Environment](docs/environment.md) — every variable, and which side may see it.
- [Testing](docs/testing.md) — what is covered, at what level, and how to run it.

## Requirements

- Node.js 20.11 or newer.
- A MongoDB instance, or the in-memory server the test suites start for themselves.
- A Solana RPC endpoint. A devnet endpoint is enough to develop against.
- For building the on-chain program: the Solana CLI, the Anchor CLI, and a Rust
  toolchain. The program cannot be built on Windows; see [docs/blockchain.md](docs/blockchain.md).

## Getting started

```bash
npm install
cp .env.example .env      # then fill in the values; see docs/environment.md
npm run dev               # the API
npm run dev:client        # the interface, in a second terminal
```

The interface is on <http://localhost:5173> and the API on <http://localhost:4000>.

## Everyday commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Runs the API with reload. |
| `npm run dev:client` | Runs the interface with reload. |
| `npm run build` | Builds the server and then the client. |
| `npm run typecheck` | Typechecks every workspace. |
| `npm run lint` | Lints every workspace. |
| `npm run test:server` | The server's unit and integration suites. |
| `npm run test:client` | The interface's component and hook suites. |
| `npm run test:e2e` | The browser flows. See [docs/testing.md](docs/testing.md). |
| `npm run audit:env` | Checks the environment against the code that reads it. |
| `npm run audit:markers` | Fails on leftover markers, debug output, and inert controls. |
| `npm run reconcile` | Compares confirmed chain state with the database and reports differences. |

## Verifying before a release

```bash
npm run typecheck
npm run lint
npm run test:server
npm run test:client
npm run test:e2e
npm run audit:env
npm run audit:markers
node scripts/audit-api-contract.mjs
npm run build
```

The API contract audit is worth singling out: it reads every path the interface
calls and every route the server declares, and fails if the interface calls
something that does not exist, or if a route exists that nothing reaches and that
is not an operational endpoint. It is what catches a client and server drifting
apart, which is otherwise only visible when a user gets an error.

## What the system deliberately does not do

- **It does not hold keys.** The server builds transactions and waits for a signed
  one to come back. It cannot move a batch on a participant's behalf.
- **It does not let the client label its own audit trail.** A verification check
  records how the *reader* arrived from the browser, but who the reader is comes
  from the server's session, so a check cannot be filed as a regulator's review
  by anything other than a regulator.
- **It does not put mutable facts in the anchored fingerprint.** Ownership and
  stage change legitimately along a supply chain. If they were part of what was
  anchored, every batch that changed hands would be reported as altered. The
  fingerprint covers registration facts only, and who holds a batch now is
  answered by the chain instead.
- **It does not let a read inflate the record.** Opening a batch's page does not
  record a check. Recording one is a separate, deliberate action, so a
  regulator's count of checks is a count of checks someone meant to make.
