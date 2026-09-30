# Demonstration data

The interface can run on placeholder data: no database, no chain connection and no
wallet, with every screen populated. The point is to review the product on its own
— to see a batch's whole journey, a regulator's review queue, a compliance report —
without standing up infrastructure first.

It is not, and does not pretend to be, the real registry.

## Turning it on

```bash
# .env, or the environment the dev server is started with
DEMO_DATA=true
npm run dev:client
```

Off by default, and read at build time, so a change means a rebuild rather than a
restart.

### On Vercel

Two variables, in the dashboard under **Settings → Environment Variables**, for
**both** Production and Preview if you want preview deployments to behave the same:

| Variable | Value |
| --- | --- |
| `DEMO_DATA` | `true` |
| `DEMO_DATA_ACK` | `I understand this is not real data` |

Three things that catch people out here, all of which have happened:

- **Both are required.** `DEMO_DATA` on its own does nothing on Vercel, because a
  production build refuses fixtures without the acknowledgement as well.
- **Adding a variable does not redeploy.** Vercel inlines these at build time, so
  the old bundle keeps serving until you redeploy: **Deployments → ⋮ → Redeploy**.
- **Vite only inlines the prefixes it is told about.** `DEMO_DATA` and
  `DEMO_DATA_ACK` are listed in `envPrefix` in `client/vite.config.ts`. Without
  that line they would read as `undefined` in the browser and the switch would look
  broken while the dashboard insisted it was on.

To confirm it took, open the deployed page. If you are still on a landing page with
a "Connect wallet" button, the flag did not reach the build. The quickest way to
see what Vercel actually inlined is to open the main bundle in the browser's
sources and look for the object `import.meta.env` was replaced with: it will
contain `DEMO_DATA`, and if it is `{}` then no variable was set at all.

## Turning it off, or being sure it is off

Two things stop it being switched on by accident:

1. It is off unless `DEMO_DATA` is exactly `true`.
2. **A production build ignores it.** The interface is compiled for production on
   Vercel with `import.meta.env.PROD` set, and demo mode refuses to run there. A
   public deployment cannot serve fixture data to a real consumer even if the flag
   is set. Overriding that needs a second, deliberately awkward acknowledgement:
   `DEMO_DATA_ACK=I understand this is not real data`.

There is no third thing, deliberately. The interface does not say it is fixtures,
because a review build that announces itself is not a review of the product. That
leaves the production gate carrying the whole responsibility, so it is the part
that must not be weakened.

While fixtures are on, the reviewer is treated as already signed in with a wallet
connected. The first screen is the dashboard rather than a page asking them to be
someone, the wallet shows an address, and the connect prompt is gone. None of that
is a claim about a real session: there is no key, nothing signed, and the
production gate is unchanged.

The interface does not label itself. There is no banner, no badge and no mention of
placeholder data anywhere in it, because the point of a review build is to look
like the product. What stands behind that is the gate in `mode.ts`, not a notice
on the screen: a production build answers from the API unless someone sets both
`DEMO_DATA` and a second acknowledgement. If that ever needs changing, the
banner is the wrong place to try.

Requests are answered after a delay that stands in for the network, varied by what
is being asked: a read lands in the range a real API sits in, a write is slower
because preparing or confirming a transaction genuinely is, and the compliance and
reconciliation screens are slowest because those genuinely are. Without it a screen
looks loaded before it has drawn, which hides a loading state that is broken, and
every action feels identical so a reviewer cannot tell a cached screen from one
that did work.

The whole navigation is shown regardless of role, and the role gate is opened, so
the regulator's screens are reachable from one session. Ownership and role checks
are the real API's job; here they are set so that every action a product page
offers can actually be opened rather than three of the four buttons being absent.

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
DEMO_DATA=true npm run dev:client
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
