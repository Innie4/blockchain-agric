# API

Base path `/api`. Every response is a JSON envelope:

```jsonc
{ "success": true,  "data": { ... }, "message": "Human readable." }
{ "success": false, "error": { "code": "...", "message": "...", "details": [] }, "requestId": "..." }
```

The `requestId` is generated per request, returned in the `X-Request-Id` header,
and recorded in every log line for that request, so a participant reporting a
problem can quote it and the exact request can be found.

## Conventions that apply to every route

**Sessions.** A session is the HTTP-only `agri_session` cookie. A readable
`agri_csrf` cookie accompanies it.

**CSRF.** Any state-changing request must send the CSRF token in the `x-csrf-token`
header. Requests without it are refused with `CSRF_TOKEN_MISSING`. A cross-site
form post cannot set that header, which is the point.

**Idempotency.** Requests that create something accept an `Idempotency-Key`
header. A repeat with the same key returns the first result and does not create a
second record.

**Validation.** Every route with a body or query declares a schema, and the
request is rejected with `VALIDATION_ERROR` and per-field details before any
handler runs. No route reads a field it did not declare.

**Rate limits.** Authenticated reads, public reads, sign-in attempts, and uploads
have separate budgets, so a burst of anonymous verification cannot lock a farmer
out of their own batches.

**Wallet privacy.** Public responses never include a wallet address. Public
product views report a role category — "a farmer", "a processor" — instead. There
is a test that collects every key in a public payload and fails if a wallet field
is present.

**Error codes.** A fixed set, so the interface can react to a category of problem
rather than parsing English: `VALIDATION_ERROR`, `UNAUTHENTIZED`,
`CSRF_TOKEN_MISSING`, `ROLE_NOT_ALLOWED`, `NOT_FOUND`, `CONFLICT`,
`RATE_LIMITED`, `BLOCKCHAIN_*`, `HASH_MISMATCH`, `RECONCILIATION_REQUIRED`,
`UPLOAD_REJECTED`, `INTERNAL_ERROR`.

## Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/auth/nonce` | Issues a single-use nonce for an address. |
| POST | `/api/auth/verify` | Verifies a signed statement and starts a session. |
| GET | `/api/auth/me` | The current session: user, permissions, and what they still need to do. |
| POST | `/api/auth/logout` | Ends the session and clears the cookies. |

A new wallet arrives with no role and no on-chain registration. `needsRoleSelection`
and `needsOnChainRegistration` in `/api/auth/me` are what the interface uses to
route them, rather than the client re-deriving the rules.

## Participants

| Method | Path | Purpose |
| --- | --- | --- |
| PATCH | `/api/users/me` | Updates the participant's own contact details. |
| GET | `/api/users/me` | The participant's own record. |
| GET | `/api/users/participants` | The recipient picker. |

`/api/users/participants` takes `role`, `search`, `limit`, and `scope`. The
default scope, `transfer`, offers only wallets that hold an on-chain registration
and may receive a batch. `scope=directory` is the full participant list and is
restricted to regulators.

## On-chain participant registration

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/participant/register/prepare` | Phase one. Builds the registration transaction. |
| POST | `/api/participant/register/submit` | Phase two. Submits the signed bytes. |

The role is taken from the session, not the request, so a participant cannot
register themselves as a regulator. After the transaction confirms, the API
re-reads the participant account and checks the role the chain stored against the
role the account holds. If they differ, the write is reported as a hash mismatch
and an administrator is notified, rather than being accepted.

## Batches

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/products/` | Phase one of registration. |
| POST | `/api/products/:productId/submit` | Phase two. Submits the signed registration. |
| POST | `/api/products/:productId/cancel` | Abandons a registration that was never submitted. |
| GET | `/api/products/` | The caller's batches, filtered and paginated. |
| GET | `/api/products/:productId` | One batch, with the caller's permissions on it. |
| GET | `/api/products/:productId/history` | Provenance, integrity, and counts. |
| GET | `/api/products/:productId/verify` | Verification for a signed-in participant. |

`GET /api/products/:productId` returns the batch *and* the permissions the server
decided — `isOwner`, `isRegistrant`, `canTransfer`, `canRecordProcessing`,
`canRecordTransport`, `canListForSale` — so the interface never re-implements the
rules and the two cannot disagree.

## Ownership transfers

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/products/:productId/transfers` | Phase one. Builds the transfer. |
| POST | `/api/transfers/:transferId/submit` | Phase two. Submits the signed transfer. |
| POST | `/api/transfers/:transferId/acknowledge` | The recipient accepts the batch. |
| POST | `/api/transfers/:transferId/cancel` | Withdraws a transfer that was never submitted. |
| GET | `/api/transfers/` | Transfers the caller sent or received. |
| GET | `/api/transfers/pending` | Transfers awaiting the caller's action. |
| GET | `/api/transfers/:transferId` | One transfer. |

A transfer is refused if the signer is not the current owner, if the recipient is
not registered on chain, or if the recipient's role may not hold this batch. Each
is a separate error so the participant is told which rule stopped them.

## Processing, transport, stage and price

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/products/:productId/processing` | Phase one of a processing entry. |
| POST | `/api/products/:productId/processing/submit` | Phase two. |
| GET | `/api/products/:productId/processing` | Entries recorded against the batch. |
| POST | `/api/products/:productId/transport` | Phase one of a journey. |
| POST | `/api/products/:productId/transport/submit` | Phase two. |
| GET | `/api/products/:productId/transport` | Journeys recorded against the batch. |
| POST | `/api/products/:productId/status/prepare` | Phase one of a stage change. |
| POST | `/api/products/:productId/status/submit` | Phase two. |
| PATCH | `/api/products/:productId/sale` | Sets the commercial listing and asking price. |

A processing entry or journey that does not move the batch's stage needs no
signature: it is a record, not a change of custody. One that does move the stage
is a chain write and is signed. The interface asks for a signature only in that
second case.

The asking price is a commercial decision held in the records service. It is not
on chain, and `PATCH /sale` needs no signature for the same reason.

## Files

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/products/:productId/media` | Attaches images. |
| POST | `/api/products/:productId/certificates` | Attaches certificate documents. |
| GET | `/api/products/:productId/certificates` | The batch's certificates. |
| GET | `/api/media/:mediaId` | Downloads one file. |

Files go to GridFS. Every upload's bytes are hashed on the way in, and the stored
bytes are re-hashed when a batch is verified, so a substituted file is detected
rather than assumed impossible.

Images are visible to anyone. Certificates are not: a certificate may be a
licence or a lab result, and it is served only to the participants handling that
batch.

## Verification

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/verify/:productId` | Verifies a batch. No session needed. |
| POST | `/api/verify/:productId/log` | Records that this check was made. |
| GET | `/api/search/` | Public search over the registry. |

This is the one part of the API a member of the public uses, so it needs no
account. `GET` does **not** record a check — a page load is not a deliberate
check, and counting loads would let a reload inflate a regulator's record.
`POST /log` is the deliberate act, and it records who checked, in what role, and
how they arrived.

The recorded channel is decided by the server. The browser reports only how the
reader arrived — from the search page, from a scanned code, or typed directly —
because only the browser can know that. Who the reader is comes from the session,
so a client cannot file its own check as a regulator's review.

`GET` is a read: it updates the batch's cached last result, so the interface can
show freshness, but it writes no audit event.

## Compliance

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/compliance/overview` | Counts, anomalies, and recent checks. |
| GET | `/api/compliance/verifications` | The review queue, paginated. |
| POST | `/api/compliance/reports` | Generates a report over the registry. |
| GET | `/api/compliance/reports` | Reports the caller generated. |
| GET | `/api/compliance/reports/:reportId` | One report. |
| GET | `/api/compliance/reports/:reportId/export` | CSV or PDF export. |
| POST | `/api/compliance/attestations/prepare` | Phase one of a regulator's finding. |
| POST | `/api/compliance/attestations/submit` | Phase two. |

A report is a copy: the figures are fixed when the report is made, and the
criteria that produced it are printed on it. A report that could change under the
reader would not be evidence of anything.

An export is recorded as an export, attributed to the session that performed it.

## Workspace

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dashboard` | The caller's overview. |
| GET | `/api/notifications` | The caller's notifications. |
| POST | `/api/notifications/:notificationId/read` | Marks one read. |
| GET | `/api/activity` | Recent activity across the registry. |

## Operations

These are for whoever is running the service. The interface deliberately never
calls them, and `scripts/audit-api-contract.mjs` fails if it starts to.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Liveness. |
| GET | `/api/health/ready` | Readiness: database and chain. |
| GET | `/api/health/database` | Database detail. |
| GET | `/api/health/blockchain` | Chain detail: commitment, program id, reachability. |
| GET | `/api/config` | Non-secret configuration, for inspecting a deployment. |
| GET | `/api/operations/reconciliation` | Chain and database differences. |
| POST | `/api/operations/reconciliation/:taskId/resolve` | Records an administrator's decision about one. |

`/api/config` reports which network and which program the deployment is running
against. It reports no secret: no session secret, no database URI, no RPC key.
