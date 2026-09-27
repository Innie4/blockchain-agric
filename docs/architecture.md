# Architecture

## The shape of the system

Three programs, and one rule that shapes all of them: **the server never holds a
private key.**

```
                    browser                          node api                     solana
                 ┌────────────┐                 ┌────────────────┐          ┌──────────┐
  participant ──▶│  client    │  signed bytes   │                │          │          │
                 │  (react)   │────────────────▶│  verify signer │          │          │
                 │            │◀────────────────│  build tx      │─────────▶│  program │
                 │            │  confirmation   │  confirm + read│◀─────────│  (pdas)  │
                 └────────────┘                 │  hash + store  │          └──────────┘
                                                 │                │                │
                                                 │  mongodb       │                │
                                                 └────────────────┘                │
                                                                            gridfs in mongodb
```

The client never talks to Solana. It asks the API to build a transaction, asks the
participant's wallet to sign it, and hands the signature back. The API submits it,
waits for confirmation, reads the account back to see what the chain actually
recorded, and only then reports success.

## Why the writes are split in two

A blockchain write needs a signature, and a signature needs a private key. Three
arrangements are possible:

1. The server holds the key. Then a server compromise moves every batch in the
   registry, and the signature proves nothing about who acted.
2. The client builds and submits the transaction itself. Then the API is a
   bystander that cannot tell whether a write really landed, and the business
   rules that must hold after a write — write the batch's new owner, record the
   audit event — have nowhere to run.
3. The server builds and the wallet signs. This is what is implemented.

So every chain write is two requests. `prepare` returns an unsigned transaction
and everything the client needs to sign it. `submit` takes the signed bytes,
verifies the signature is by the session's own wallet, sends the transaction,
waits for the commitment the environment is configured for, and then reads the
affected account back.

That last step matters. A transaction can confirm and still not be what was
intended, and a program can reject a write the database had already been told to
expect. Confirming the transaction is not enough on its own, so the account is
re-read and compared. If they disagree, the batch is marked
`NEEDS_RECONCILIATION` and an administrator is given the signature to investigate
rather than the participant being told their write succeeded.

## Where each responsibility lives

### The Anchor program

Holds the things that must not be editable by anyone, including the operator:

- who is a registered participant, and in what role;
- which wallet owns which batch;
- what stage a batch is in, and which transitions are legal;
- what a regulator has attested about it;
- the fingerprint that was anchored when the batch was registered.

It deliberately holds no personal details, no descriptions, and no file contents.
It holds hashes, counts, roles, and addresses, so a batch's story is legible
without making the chain a place to store produce.

### The API

Owns everything the chain should not:

- **Hashing.** Producing the canonical fingerprint (see [blockchain.md](blockchain.md)).
- **Storage.** Batch metadata in MongoDB, images and certificates in GridFS.
- **Sessions.** Sign-in is a signed nonce challenge; the session is an HTTP-only
  cookie, and state changes additionally require a CSRF token.
- **Business rules.** Which role may do what, and the audit trail of who did.
- **Reporting.** Compliance reports over the registry, and CSV and PDF exports.

### The interface

Renders what the API says and sends back what the API accepts. It holds no
private key, keeps no authoritative copy of anything, and re-asks rather than
guessing. Where the server decides a permission — whether this session may
transfer this batch, for instance — the interface renders the answer instead of
repeating the rule, so the two cannot drift apart.

## Sessions and requests

Authentication is a challenge and a signature. The API issues a single-use nonce,
the wallet signs a statement that includes it, and the API checks the signature
against the address that signed in. A replayed nonce is refused, and repeated
failures lock the address out for a cooling-off period.

The session itself is an HTTP-only, SameSite cookie. A readable `agri_csrf`
accompanies it, and any state-changing request must echo it in `x-csrf-token`.
The cookie's contents are digested with `SESSION_SECRET`, so rotating the secret
invalidates every outstanding session without a database migration.

Requests that create something accept an `Idempotency-Key`. Repeating a request
with the same key returns the first result rather than creating a second record,
so a participant who retries after a timeout does not end up with two batches.

## How a batch's story stays checkable

At registration the API computes one fingerprint over the batch's immutable
registration facts and stores that fingerprint on the chain. Verification
recomputes the same fingerprint from what is stored now and compares it with
what the chain holds.

The comparison is only meaningful if the fingerprint covers nothing that is
supposed to change. Ownership passes along the supply chain, and stage changes
many times, so neither is in it. This is easy to get wrong and expensive when you
do: a fingerprint that includes the current owner cannot be reproduced after the
first transfer, so every batch that has changed hands reports as altered, and the
system tells a farmer their produce has been tampered with when it has not. The
fingerprint therefore covers registration facts only, and the set of facts is
versioned so a change to it is a recognisable change rather than a silent
incompatibility.

## Failure and recovery

Chain writes and database writes cannot be made atomic together. The API does not
pretend otherwise. It records an intent before submitting, and reconciles
afterwards. `npm run reconcile` compares every batch the chain knows about with
what the database holds, and reports:

- a chain write that confirmed but never reached the database;
- a database record with no chain write behind it;
- a batch whose stored fingerprint no longer matches the anchored one;
- a batch whose stored owner and stage disagree with the chain.

It reports; it does not repair. A tool that silently rewrites records is a tool
that can destroy the one thing the system is for.

## Testing strategy

Three levels, each answering a different question.

**Unit** — the canonical serialisation, the account layout, the state machine, the
formatters. Pure functions, no I/O.

**Integration** — the real Express app against a real MongoDB, with the chain
replaced by an in-process client that enforces the same account rules. This is
where the security properties are asserted: that a rejected role cannot write,
that a read cannot inflate the check count, that a hash mismatch is reported
rather than hidden.

**End to end** — a real browser, the real interface, the real API, a real MongoDB,
and a mock Solana transport. Nothing in `client/src` is modified for these tests;
they use the interface as a participant would. Seven flows cover registration,
transfer and processing, transport and retail, public verification, tamper
detection, compliance reporting, and a declined signature.

The mock chain is a test double, and it is confined to the test environment. The
production path always uses the real RPC client.
