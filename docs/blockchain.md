# The blockchain layer

## What the program is for

The program is the part nobody can quietly edit, including the operator of the
API. It answers four questions, and refuses to answer anything else:

- **Who is a participant, and in what role?** A wallet that has not registered
  cannot hold a batch, and a role that is not registered cannot be claimed.
- **Who owns this batch?** One wallet, changed only by a signed handover.
- **What stage is it in?** With the legal transitions from each stage.
- **What has a regulator attested about it?**

It holds no descriptions, no personal details and no file contents. It holds
addresses, roles, statuses, counters, timestamps and hashes, so a batch's history
is legible on chain without the chain becoming a place to store produce.

## Accounts

Two kinds, both program-derived addresses, so nothing can be passed off as one of
ours.

**Participant account** — one per registered wallet: a layout version, its bump
seed, the wallet, its role, the instant it registered, a SHA-256 fingerprint of
the profile the participant supplied, and whether a regulator has revoked the
entry.

**Product account** — one per batch identifier: a layout version, its bump seed,
reserved feature bits, the current status, the status held immediately before any
regulator flagging, the human-readable identifier, the registrant, the current
owner, the registration instant, the instant of the last state change, the instant
of the last transfer, the instant of the last attestation, the anchored data
hash, and the completed transfer count.

The status before flagging is stored rather than inferred, so releasing a flagged
batch returns it to the stage it genuinely held rather than to a guess.

Addresses are derived from seeds, so a batch's account is found by its identifier
alone — anyone can recompute the address and read the account without an indexer.

```bash
# The address for a batch, recomputed from its identifier.
solana account <address> --url <rpc>
```

## Instructions

| Instruction | Who may call it | What it does |
| --- | --- | --- |
| `register_participant` | Any wallet | Adds the signer to the registry with a role and a profile fingerprint. |
| `register_product` | A registered participant | Creates the batch account with the anchored hashes. |
| `transfer_ownership` | The current owner | Moves the batch to a registered participant and counts the transfer. |
| `update_status` | The current owner | Moves the batch to a stage the state machine allows. |
| `record_verification` | A registered regulator | Attaches a regulator's finding to the batch. |

The rules the program enforces, and why each is on chain rather than in the API:

- **Only the current owner may transfer or restage.** If the API enforced this, a
  bug or a compromised API could move produce that is not its own to move.
- **A recipient must already be registered.** Otherwise a transfer could hand a
  batch to a wallet that can never act on it.
- **A recipient's role must be allowed to hold the batch.** A batch cannot be
  handed to a regulator for onward sale.
- **Stage transitions must be legal.** The program allows exactly one step at a
  time: `REGISTERED → IN_PROCESSING → PROCESSED → IN_TRANSIT → AT_RETAILER →
  LISTED → SOLD`. A hand-set status would make the stage meaningless.
- **A regulator may flag a batch, and a flagged batch is held.** `FLAGGED` blocks
  further movement until a regulator releases it, which returns it to the stage it
  held before it was flagged. `SOLD` is terminal.
- **Only a regulator may attest.** A finding is a claim about produce, and the
  party with something to gain from the claim must not be the one making it.
- **Only a farmer or a regulator may register a batch.** A processor cannot create
  produce that does not exist.

## Errors

The program returns named errors rather than generic failures, so the API can
distinguish "you are not the owner" from "that transition is not allowed" and tell
the participant which rule stopped them.

| Error | Meaning |
| --- | --- |
| `DuplicateProduct` | A batch already exists at the address this identifier derives. |
| `UnauthorizedOwner` | The signer is not the batch's current owner. |
| `InvalidRecipient` | The recipient is not in the on-chain registry. |
| `RecipientRoleNotAllowed` | The recipient's role may not hold this batch. |
| `InvalidStateTransition` | The requested stage is not a legal step from the current one. |
| `MalformedIdentifier` | The batch identifier failed on-chain validation. |
| `ProductFlagged` | A regulator has withheld this batch. |
| `ProductClosed` | The batch has reached a terminal status. |
| `RegulatorOnly` | The caller is not a registered regulator. |
| `ParticipantNotRegistered` | The signer has no on-chain registry entry. |
| `ParticipantAlreadyRegistered` | This wallet is already registered. |
| `RegistrantRoleNotAllowed` | Only a farmer or regulator may register a batch. |
| `InvalidTimestamp` | The supplied time is not plausible for the cluster. |

The codes are stable. `server/src/services/solana/errorMapping.ts` maps each one
onto the API's error taxonomy, so the interface is told what happened rather than
being handed an opaque failure.

## Events

Every accepted write emits an event, so a third party can follow a batch without
trusting the API's database at all.

| Event | Emitted when |
| --- | --- |
| `ParticipantRegisteredEvent` | A wallet joins the registry, with its role and profile fingerprint. |
| `ProductRegistered` | A batch is created, with its registrant, owner, status and anchored hash. |
| `OwnershipTransferred` | A batch changes hands, with both wallets, the transfer identifier and the new count. |
| `ProductStatusUpdated` | A batch changes stage, with the previous and new status and who moved it. |
| `VerificationRecorded` | A regulator attests, with the finding, the verifier and the hash that was checked. |

Each transfer carries a transfer identifier on chain, so a handover recorded in
the database can be tied to exactly one chain event and a chain event to exactly
one handover. That correspondence is what makes a disagreement detectable.

## The anchored fingerprint

This is the part worth being careful about.

At registration the API computes one SHA-256 digest over a canonical
serialisation of the batch's **immutable registration facts**, and the program
stores that digest. Verification recomputes the digest from what is stored now and
compares.

The canonical form is a fixed, line-oriented byte stream, not `JSON.stringify`,
because a fingerprint that depends on key insertion order cannot be reproduced by
someone verifying the batch years later:

```
version:v2
productId:AGT-COCOA-2026-A1B2C3
cropType:COCOA
quantity:250.00
unit:kg
harvestDate:2026-01-14
farmLocation:Kumasi, Ghana
description:Washed cocoa beans from the 2026 main harvest.
additionalNotes:
registeredByWallet:5wHu1tD9BqKvK9XhW1jF5Hq3pT9nGqQZ3mQ2rY7vKpP
imageHashes:a3f1…,9c02…
certificateHashes:
registeredAt:2026-01-15T11:02:03.456Z
```

One `field:value` line per field, in a declared order, values normalised, joined
by newlines and newline-terminated. A field that is absent is written empty, so
adding and removing a field never produce the same bytes. Newlines, tabs,
backslashes and carriage returns inside a value are escaped, so a value can never
be mistaken for a field boundary, and the encoding round-trips.

### The rule that matters

**Nothing that is supposed to change may go in the fingerprint.**

The current owner is the obvious trap. Ownership passes along the supply chain by
design, so a fingerprint that includes it cannot be reproduced after the first
transfer — and every batch that has changed hands reports a mismatch. The effect
is that the system tells a farmer their produce has been tampered with when it has
not, which is worse than not checking at all: it destroys trust in a check that
does work.

So the fingerprint covers registration facts only. The registrant is already
covered by `registeredByWallet`, and *who holds the batch now* is answered by the
on-chain transfer history and the product's own ownership field, which is where a
mutable fact belongs.

Stage is excluded for the same reason: a batch is expected to change stage many
times.

The version line exists because this list is the contract. Changing which facts
are anchored changes the bytes, so the version must be bumped — otherwise an old
anchor would be silently compared against a new scheme and every previously
registered batch would report as altered.

## The two-phase write

No server-held keys, so every chain write is split.

**Phase one — `prepare`.** The API validates the request, checks the session's
role, builds the instruction, derives the account addresses, encodes the
transaction, and returns it base64-encoded along with the addresses, the blockhash
and its expiry, and a short description for the wallet to show the participant.

**Phase two — `submit`.** The API:

1. Decodes the signed transaction and checks the signature is by the session's own
   wallet. A transaction signed by anyone else is refused.
2. Re-checks the preconditions, so a request cannot be prepared under one set of
   facts and submitted under another.
3. Sends it and waits for the configured commitment.
4. **Re-reads the affected account from the chain** and compares it with what the
   API expected.
5. Only then writes to the database and records the audit event.
6. Returns the record.

Step 4 is the one that is easy to omit and expensive to skip. A transaction can
confirm and still not be what was intended, and the program can reject a write the
database was already told to expect. Comparing the account after confirmation is
what makes "confirmed" mean "this is now true" rather than "something was
accepted".

If the account does not match, the batch is marked `NEEDS_RECONCILIATION`, the
signature and both versions are recorded, an administrator is notified, and the
participant is told not to retry. Retrying a write that already landed is how a
registry ends up with two records of one handover.

## Commitments and confirmations

| Variable | Purpose |
| --- | --- |
| `SOLANA_COMMITMENT` | The commitment a write waits for: `processed`, `confirmed` or `finalized`. |
| `SOLANA_PREFETCH_COMMITMENT` | The commitment used when *reading* for verification, so reads can be cheaper and faster than writes. |
| `SOLANA_TX_TIMEOUT_MS` | How long to wait before reporting a write as unresolved. |
| `SOLANA_RETRY_ATTEMPTS` | Retries for a transient RPC failure. |

A read that does not need to be final does not have to wait for finality, so reads
and writes are configured separately. A production deployment should use
`finalized` for writes.

## Building and deploying

The program is an Anchor project. Two different builds are involved, and it is
worth not confusing them:

- `cargo build` compiles the Rust for the **host**. This works on Windows once
  the Visual Studio Build Tools are present, and it is what proves the source is
  sound and what runs the unit tests.
- `anchor build` compiles the Rust for **Solana's SBPF virtual machine** and emits
  a deployable `.so` plus the IDL. This needs the Solana toolchain, and the BPF
  toolchain only runs on Linux and macOS.

```bash
# Host build, any platform with a linker. Proves the source compiles.
cd programs/agri_trace
cargo build --release
cargo test --lib

# Solana build. Linux or macOS, or WSL2. Produces the deployable artefact.
anchor build          # writes target/deploy/agri_trace.json and target/idl/agri_trace.json
anchor test           # the program's own positive and negative tests
anchor deploy --provider.cluster devnet
```

Then set `SOLANA_PROGRAM_ID` to the deployed program's address.

On Windows, use WSL2 for the Solana build. The host build works natively, but
`cargo build-sbf` does not.

### State of the build in this repository

The Rust source **compiles and its tests pass.** On Windows, with the Visual
Studio Build Tools toolchain providing the linker:

```bash
cd programs/agri_trace
cargo check
cargo build --release
cargo test --lib
cargo clippy --all-targets
```

All four are clean: no errors, no warnings, and 10 unit tests passing. Those tests
cover the wire-format constants, the account sizes, the role and status ordinals,
the stage machine, and the batch identifier grammar.

Getting there fixed five real defects that had never been compiled before:

| Problem | Why it mattered |
| --- | --- |
| `ProductStatus` and `ParticipantRole` had no `InitSpace` derive | The accounts had no computable size, so they could not be allocated. |
| `product_id` had no `#[max_len]` | Anchor cannot size a `String` field without a bound. |
| `seeds = [PRODUCT_SEED, product_id…]` with no `#[instruction]` | The derive could not type the seed, so no product account could be created. |
| `Program<'info, System>` | Does not compile on anchor-lang 0.30.1: the `Program` wrapper requires its type to implement `AccountDeserialize`, which `System` does not. Replaced with an address-checked `AccountInfo`, which is also the stricter check. |
| `validate_event_time` was dead code | The timestamp rule was duplicated inline in two handlers, so one copy could be changed without the other. Both now call the one implementation. |

Two further issues were found by the tests that were added:

- The program's identifier check accepted any printable string up to the length
  bound, while the API accepts only `AGT-[A-Z0-9]{3,6}-\d{4}-[A-Z0-9]{6}`. Since
  the identifier becomes a PDA seed, the program could have accepted a batch the
  application could never address. The grammar is now enforced on both sides, and
  a test asserts the two agree case by case.
- The account sizes are now asserted against the values the backend hard-codes
  (`PRODUCT_ACCOUNT_SIZE = 181`), so a field change on either side fails a test
  rather than producing accounts the other side misreads.

### What is still not verified

**The program has not been built for Solana, and `anchor test` has not run.**

The deployable artefact is a `.so` built by `cargo-build-sbf`, and the parts of
that toolchain are not obtainable in this environment:

- `anchor` CLI 0.30.1 publishes no binary asset on its GitHub release.
- `cargo-build-sbf` is not inside the platform-tools tarballs, and the only
  version on crates.io needs a newer cargo than any shipped toolchain provides.
- `release.solana.com`, which the official installer uses to fetch both, is not
  reachable from this network. GitHub is reachable, which is how the compiler
  errors above were found at all, but the toolchain the BPF build needs is not
  published there.

So on a machine with those tools, the remaining step is:

```bash
anchor build
anchor test
anchor deploy --provider.cluster devnet
```

The TypeScript tests for the program are written and cover the happy paths and
the rejections — an unauthorised transfer, an illegal transition, a duplicate
registration, a recipient who may not hold the batch, a non-regulator
attestation. They have never been executed, so treat the program as compiled and
unit-tested but not yet run against a validator.

The API and the interface do not depend on the program being built: they talk to
whatever `SOLANA_PROGRAM_ID` points at, and the whole test suite runs against an
in-process chain client that enforces the same account rules.

## Reconciling

`npm run reconcile` compares what the chain holds with what the database holds and
reports, per batch:

- a chain write that confirmed but never reached the database;
- a database record with no chain write behind it;
- a stored fingerprint that no longer matches the anchored one;
- a stored owner or stage that disagrees with the chain.

It reports; it does not repair. A tool that silently rewrites records can destroy
the one thing this system exists to protect, so a human decides what happens to
each difference, and their decision is itself recorded.
