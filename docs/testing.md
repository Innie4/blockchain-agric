# Testing

Three levels, each answering a different question. 475 server tests, 160 client
tests, 10 program tests, 7 end-to-end flows.

| Level | Question it answers | How it runs |
| --- | --- | --- |
| Program unit | Is the on-chain logic right on its own? | `cargo test --lib`, no validator. |
| Unit | Is this piece of logic right on its own? | Pure functions, no I/O. |
| Integration | Does the API hold its promises over HTTP? | The real app, a real MongoDB, an in-process chain. |
| End to end | Can a participant actually do this? | A real browser, the real interface, the real API. |

## Running them

```bash
cd programs/agri_trace && cargo test --lib   # the program
npm run test:server      # unit and integration
npm run test:unit        # unit only
npm run test:integration # integration only
npm run test:client      # interface
npm run test:e2e         # browser flows
```

Then, before a release:

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

## The program suite

`cargo test --lib` runs 10 tests inside the Anchor program, and they are the
tests that matter most for the boundary between the chain and the application:

- **Account sizes** are asserted against the values the backend hard-codes when
  it allocates and decodes. A field added or resized on one side fails a test
  rather than producing accounts the other side misreads.
- **Ordinals** for the role and status enums are pinned, because those numbers
  are the wire format and renumbering them would silently reinterpret history.
- **The stage machine** is asserted to advance one step at a time.
- **The identifier grammar** is asserted to agree with the backend's pattern, case
  by case, so the two definitions of a valid batch identifier cannot drift.

That last pair of tests found real problems. The program's identifier check
accepted any printable string, so it could have created a batch the application
could never address, because the identifier is a PDA seed. It now enforces the
same grammar as the API.

## The server suite

Integration tests run the real Express application against a real MongoDB. The
Solana client is replaced by an in-process implementation that enforces the same
account rules the program does — a transfer from a wallet that does not own the
batch fails, an illegal stage change fails — so the API's own handling of those
failures is genuinely exercised rather than mocked away.

| File | What it covers |
| --- | --- |
| `canonicalHash.test.ts` | The canonical serialisation, escaping, round-tripping, and which facts the fingerprint may contain. |
| `solanaLayout.test.ts` | The account encoder and decoder, including decoding the program's own bytes. |
| `statusMachine.test.ts` | Which stage changes are legal, and which are refused. |
| `roles.test.ts` | Which role may do what. |
| `identifiers.test.ts` | Batch identifier validation. |
| `sessionDigest.test.ts` | Session cookie signing and verification. |
| `walletSignature.test.ts` | Signature verification, replayed nonces, and lockout after repeated failures. |
| `auth.test.ts` | The sign-in flow. |
| `productRegistration.test.ts` | Registration, including rejection of a bad signature and of a batch that already exists. |
| `transfer.test.ts` | Handover between participants. |
| `processingTransportCertificates.test.ts` | Entries, journeys, and certificates. |
| `verification.test.ts` | Public verification, tamper detection, and what a read may and may not record. |
| `tamperDetection.test.ts` | Altering a stored record after registration, and the mismatch being reported. |
| `fileStorage.test.ts` | Uploads, GridFS, hashing, and access rules. |
| `complianceReport.test.ts` | Report generation, criteria, and exports. |
| `complianceAndOperations.test.ts` | Review queue, attestations, and reconciliation. |
| `listRoutes.test.ts` | That every query route applies its schema, rather than silently losing its defaults and bounds. |
| `errorMapping.test.ts` | That every error code maps to the right status and message. |

Three of these deserve naming, because they assert properties rather than
behaviour:

- **`canonicalHash.test.ts`** asserts the fingerprint is unchanged when ownership
  moves. A batch that has been handed on must still verify; a fingerprint that
  could not be reproduced after a transfer would report every such batch as
  tampered with.
- **`verification.test.ts`** asserts a public response contains no wallet address
  at all, by collecting every key in the payload.
- **`verification.test.ts`** also asserts that reading a batch records no audit
  event, and that logging a check does.

## The client suite

Components are rendered with a stubbed wallet and a recording HTTP double, and
asserted on what a participant sees and can reach.

| File | What it covers |
| --- | --- |
| `registerProduct.test.tsx` | The registration form, including validation and the signing stages. |
| `asyncStates.test.tsx` | Loading, empty, failed and retry states; live regions; transaction progress. |
| `walletStates.test.tsx` | Not connected, connecting, wrong network, locked, no provider. |
| `routeGuards.test.tsx` | That a guarded route redirects, and says where to. |
| `verification.test.tsx` | The public check, and the deliberate act of recording it. |
| `accessibility.test.tsx` | Landmarks, labels, focus order, and keyboard reachability. |

## The end-to-end flows

`tests/e2e` drives a real Chromium against the real interface, the real API, a real
MongoDB, and a mock Solana transport. Nothing in `client/src` is modified for
these tests: they use the interface as a participant would, and they assert the
interface's own confirmation messages as well as the underlying state.

| Flow | What it proves |
| --- | --- |
| FLOW 1 | A farmer signs in, registers a batch, and the registration is on chain. |
| FLOW 2 | A handover to a processor, a processing entry that moves the stage, and a history that shows both. |
| FLOW 3 | Processor to transporter to retailer, a recorded journey, a listing, and the whole journey on the public record. |
| FLOW 4 | A member of the public checks a batch with no account, and the record of that check. |
| FLOW 5 | A stored record altered after registration is reported as a mismatch, not as verified. |
| FLOW 6 | A regulator reviews a batch, generates a report, and exports a CSV that really contains the batch. |
| FLOW 7 | A declined signature leaves the batch where it was, and says so. |

```bash
cd tests/e2e
npx playwright test                     # all seven
npx playwright test --headed            # watch it happen
npx playwright test specs/flow-4-*.ts   # one flow
npx playwright test --debug             # step through
```

### How the harness is built

**A real wallet, stubbed at the standard interface.** The tests install a
`window.solana` provider that produces genuine Ed25519 signatures, so signature
verification, transaction decoding and every check the API makes are exercised for
real. Only the key material is a test key.

**A mock chain at the transport boundary only.** The mock speaks the Solana JSON
RPC shape, so the API's RPC client, its retry logic, its confirmation wait and its
account decoding all run unmodified. It is confined to the test environment; the
production path always uses the real client.

**A real database, reset authoritatively.** Each test starts by dropping the
database and then reading it back to confirm it is empty. A partial reset that
quietly leaves a document behind does not fail where it happens — it surfaces much
later as a recipient picker offering two identically named participants, which
costs far more time to diagnose than a reset costs to do properly.

**Recipients chosen by wallet.** A person's name is not a unique key. The tests
pick a recipient by its wallet address and then assert the name that address
belongs to, which is both unambiguous and a stronger check.

## The audits

These are not tests, but they fail a build, and each has caught something real.

```bash
npm run audit:env                      # environment against the code that reads it
npm run audit:markers                  # leftover markers, debug output, inert controls
node scripts/audit-api-contract.mjs    # client paths against server routes
```

**`audit-env`** reads every variable the code reads and every variable
`.env.example` documents, and fails on any mismatch in either direction. It also
fails if a server-only secret is exposed to the browser, which is the one mistake
here that would not be caught by any functional test.

**`audit-markers`** fails on TODO markers, placeholder copy, debug output, and
controls that exist but do nothing. It exists because an inert control is worse
than a missing one: it looks like a feature.

**`audit-api-contract`** reads every path the interface calls and every route the
server declares. It fails if the interface calls something that does not exist, or
if a route exists that nothing reaches and that is not an operational endpoint.

This last one earns its place. A client that declares a response shape the server
does not send will not fail to compile — it will read `undefined` from a write
that actually succeeded, and tell a farmer their registration failed when it
landed. That is exactly the class of defect these audits were written to catch, and
the end-to-end flows are what found it.

## What is not covered

- **The program has not been built for Solana or run against a validator.** Its
  Rust compiles, and its unit tests pass, but `anchor build` and `anchor test`
  need a toolchain this environment cannot fetch. See
  [blockchain.md](blockchain.md).
- **No test runs against a live Solana cluster.** The end-to-end flows use a mock
  transport. Behaviour against a real cluster — confirmation latency, fee
  behaviour, rate limits — is not covered, and a devnet run is still worth doing.
- **Load and performance are not measured.** Nothing here establishes a throughput
  or latency figure.
