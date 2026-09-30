# Demonstration data

The interface can run on placeholder data: no database, no chain connection and no
wallet, with every screen populated. The point is to review the product on its own
— to see a batch's whole journey, a regulator's review queue, a compliance report —
without standing up infrastructure first.

It is not, and does not pretend to be, the real registry.

## Turning it on

```bash
# .env, or the environment the dev server is started with
VITE_DEMO_DATA=true
npm run dev:client
```

Off by default, and read at build time, so a change means a rebuild rather than a
restart.

## Turning it off, or being sure it is off

Three things stop it being switched on by accident:

1. It is off unless `VITE_DEMO_DATA` is exactly `true`.
2. **A production build ignores it.** The interface is compiled for production on
   Vercel with `import.meta.env.PROD` set, and demo mode refuses to run there. A
   public deployment cannot serve fixture data to a real consumer even if the flag
   is set. Overriding that needs a second, deliberately awkward acknowledgement:
   `VITE_DEMO_DATA_ACK=I understand this is not real data`.
3. **A banner is shown on every screen** while it is on, saying so in the same
   place on every page, and not dismissible. The demonstration is useful precisely
   because it looks like the product, which is also the risk: someone could draw a
   conclusion from it. A notice that could be closed is a notice that will be
   closed.

While demo data is on, the reviewer is treated as already signed in with a wallet
connected. The first screen is the dashboard rather than a page asking them to be
someone, the wallet shows the demonstration's own address, and the connect prompt
is gone. None of that is a claim about a real session: there is no key, nothing
signed, and the banner is still on every page saying the data is placeholder.

The landing page has not been thrown away, it is at `/landing`.

## What the data is

Seven batches, five participants, covering every stage the product knows:

| Batch | Stage | Why it is there |
| --- | --- | --- |
| `AGT-COCOA-2026-A1B2C3` | Registered | The simplest case: one event, nothing handed on. |
| `AGT-SOYBEAN-2026-C4D5E6` | In processing | Handed to a processor. |
| `AGT-CASHEW-2026-C3D4E5` | In transit | Handed to a transporter. |
| `AGT-PLANTAIN-2026-F6G7H8` | At retailer | The full chain, with a certificate. |
| `AGT-TOMATO-2026-H9J0K1` | Listed | A commercial listing with a price. |
| `AGT-MAIZE-2026-K2L3M4` | Sold | A terminal batch. |
| `AGT-GINGER-2026-M5N6P7` | Flagged | Withheld by a regulator, for the compliance screens. |

### The fingerprints are real arithmetic

Each batch's registration fingerprint is **computed by the server's own canonical
module**, not written by hand:

```bash
cd server
npx tsx scripts/generate-demo-data.ts
```

So the verification screen is doing real SHA-256 over placeholder facts and
reaching the correct verdict, and the detail page genuinely shows the anchored and
stored digests agreeing. A fixture with an invented hash would have made that
screen look right while proving nothing, which is the opposite of what it is for.

Re-run the generator after any change to the canonical format, or the digests will
stop matching what the real API would compute.

### The provenance is consistent with the stage

A batch's timeline is built from the hand-overs it actually had, in chronological
order, with the right wallets in each entry. A batch registered and never handed on
has one event. A batch that reached a retailer has the registration, each transfer,
the processing and journey entries that moved it, the listing, and — for a flagged
batch — the regulator's finding. Nothing appears that the batch's own stage does not
support.

## What it deliberately does not do

**It does not sign anything.** A write in demo mode returns the shape the API would
return, with a transaction signature that was never signed and an account that holds
no code. That is the one thing a viewer must be able to tell from a real one, so it
is left visible rather than faked convincingly.

**It does not fetch files.** There are no photographs or certificates to download.
The metadata is present and honest about the absence.

**It does not survive a change to the wire format.** A field the router does not
know about will not appear, and the screens that read it will show less than they
should. That is the maintenance cost of a fixture, and it is why the read paths
assert on content rather than on the request succeeding.

## How it is wired in

Every call the interface makes goes through `ApiClient.request`, so demo mode
intercepts there — one place, and no screen knows the difference.

```
src/demo/
  mode.ts        is demo data on, and whether this build may serve it
  types.ts       the shape of the generated data
  generated.ts   written by the server's generator; do not hand-edit
  dataset.ts     the dataset, and the records the screens render
  router.ts      method and path to response
```

A path with no handler throws. A demonstration that quietly showed an empty screen
where the product would have shown a failure would hide exactly the problem it
exists to surface.

## Checking it

```bash
VITE_DEMO_DATA=true npm run dev:client
```

Then, in a browser:

- `/` — the dashboard, the wallet already connected, the session already open
- `/landing` — the landing page, still there to read
- `/search` — search for `cocoa`, or `plantain`
- `/verify/AGT-COCOA-2026-A1B2C3` — a batch that matches its record
- `/verify/AGT-COCOA-2026-ZZZ999` — an identifier that is not registered
- `/app/dashboard` — figures and a table
- `/app/products/AGT-PLANTAIN-2026-F6G7H8` — the whole journey, and both fingerprints
- `/app/products/AGT-PLANTAIN-2026-F6G7H8/history` — the timeline and its integrity

These were checked in a real browser, ten assertions on rendered content rather
than on the request succeeding, with the same check run against a build with demo
data off to confirm it is inert there. That check is not yet part of the
end-to-end suite; it needs to be, so this stays true when the routes move.
