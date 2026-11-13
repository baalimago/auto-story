# Auto Story

Drop a PDF or a text document. Pi reads it, invents a gentle picture-book
world for its ideas, writes an interactive storybook site, and the builder
paints the pages and deploys the book as a **new Wasmer Edge app**.

```
 browser                         auto-story (Edge app, Edge.js)                      Wasmer / OpenAI
 ───────                         ──────────────────────────────                      ───────────────
 drop PDF ─ pdf.js → text ──POST /api/builds──► workspace /tmp/auto-story/<id>
                                 │  site/ ← agent/template (engine)
 NDJSON progress ◄───────────────┤  Pi child process (/bin/node pi_entry.mjs) ──► builder's model + key
                                 │     writes story.js, scenes.js, art/plan.json
                                 │     runs node /agent/check.mjs until ok
                                 │  check again (no secrets in env)
                                 │  paint art/plan.json (or Pi draws SVG) ───────► OpenAI Images
                                 │  zip site/ → signed upload → deployViaAutobuild ─► registry.wasmer.io
                                 │  poll build, wait for x-edge-app-version-id
 "Open the book →" ◄─────────────┘  gallery entry → /data/stories/<id>.json
```

## The book format

Every generated app is static: `index.html`, `book.js` and `book.css` are
the engine (`agent/template/`), and Pi writes the rest.

| File | Author | Content |
|---|---|---|
| `story.js` | Pi | Title, palette, pages (text, art id, scene, grown-up note), cast list |
| `scenes.js` | Pi | Interactive SVG scenes on a 1500×1000 layer over the backdrop |
| `art/plan.json` | Pi | Shared style, character sheet, one prompt per backdrop |
| `art/*.webp` | Builder | Painted with `OPENAI_IMAGE_MODEL`, 1536×1024, when an OpenAI key is available |
| `art/*.svg` | Pi | Drawn by Pi when there is no image key (`artExtension: 'svg'`) |

Every book and the builder carry a "powered by Wasmer" badge through
[watermark.wasmer.app](https://watermark.wasmer.app/). The badge
(`powered-by-wasmer.svg`) is built from the official wordmark in
`frontend-edge/public/logos/logo-wasmer.svg`; the coordinator restores it
after Pi, and `check.mjs` requires the watermark script in `index.html`.

**Look.** Builders pick a style (watercolor picture book, comic book,
manga), a year for comics (1938–2026) and manga (1950–2026), and colour or
black & white. `server/looks.mjs` maps the year to an era description
(Golden, Silver, Bronze, Modern, Contemporary comics; Tezuka-era,
shōjo/gekiga, 90s, 2000s, modern manga). That directive leads every image
prompt, is handed to Pi as `INPUT.look`, and selects the engine theme
(`story.theme`, `story.mono`), which `check.mjs` enforces.

Each page pairs a short picture-book sentence with a **For grown-ups**
note that states the real, technical explanation. The last page maps
every character to the concept it stands for. Arrow keys, swipe, and
`#/<page>` links work like gentlydownthe.stream.

`agent/ENGINE.md` is the contract Pi reads. `agent/check.mjs` validates
the schema and limits (`agent/limits.mjs`) and runs every scene, its
click handlers, and its timers against a fake DOM.

## Access and deploy credentials

The builder has **no secrets**. Visitors paste a Wasmer access token
(https://wasmer.io/settings/access-tokens). The browser keeps it in
`sessionStorage` (and `localStorage` with "Remember my token") and sends it
with each build, like the model key. Per request the backend runs the
equivalent of `WASMER_TOKEN=<token> wasmer whoami`
(`viewer { username namespaces }`, cached 5 minutes by token hash), checks
`server/allowlist.json` (`users`, or membership in one of `namespaces`),
and then deploys the book **with that token**, under the visitor's own
account (or `STORY_OWNER`, if set and the visitor can deploy there).
The token lives only in memory for the build, is redacted from every
event, and never reaches Pi.

## Private shelves

Each Wasmer account has its own shelf. Requests carry the token as
`Authorization: Bearer <token>`; `server/auth.mjs` resolves it to an
identity whose `account` key is the Wasmer **user id** (`wasmer:<id>`), not
the username, so a renamed account keeps its books. Books are filed under
`/data/stories/<sha256(account)>/<build id>.json` (`server/stories.mjs`),
and `/api/stories`, a build's event log and abort all check that the
caller's account started the build. Books saved before this change (flat
`/data/stories/*.json`) move to their owner's shelf the first time that
username lists it.

The deployed books are still Wasmer Edge apps, which are reachable by
anyone with the URL, so app names end in 10 random characters to make
them unguessable.

"Login with Wasmer" will slot into `credentialFrom()` in
`server/auth.mjs` (a session cookie that resolves to the same identity)
and `authHeaders()` in `public/app.js`; nothing else needs to change.

The `wasmer login` browser flow does not work here: the registry's
`newNonce` only accepts callback URLs on `localhost` with an explicit port
(`backend/rust/crates/sm_be_iam/src/nonces.rs`).

## Models: bring your own key

Each build uses the builder's own model settings from the **Model** panel:

| API | Default base URL | Default model | Pi env |
|---|---|---|---|
| Anthropic Messages | `https://api.anthropic.com` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| OpenAI Responses | `https://api.openai.com/v1` | `gpt-6-luna` | `OPENAI_API_KEY` |
| OpenAI-compatible Chat Completions | required | required | `OPENAI_API_KEY` |

Unknown model ids and custom endpoints borrow Pi's metadata from a model
of the same API (`pi_entry.mjs`). The key travels in the build request,
lives only in memory for that build, reaches only the Pi child and the
painter, and is redacted from every event. The OpenAI Responses key is
reused for paintings; other APIs take an optional OpenAI key for
paintings, and without one Pi draws SVG backdrops. "Remember these on
this device" stores the settings in the browser's localStorage.

This is deliberately trusting: the backend sees the keys, and so could a
malicious document that talks Pi into printing its environment.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `OPENAI_IMAGE_MODEL` | env | Default `gpt-image-1`. `OPENAI_IMAGE_QUALITY` defaults to `medium`. |
| `STORY_OWNER` | env | Optional namespace for books instead of the visitor's own account. |
| `MAX_ACTIVE_BUILDS` | env | Per instance, default 2. |

## Run locally

```bash
npm ci --prefix pi --ignore-scripts --no-bin-links --no-audit --no-fund
npm run --prefix pi prepare:wasmer
scripts/dev.sh
```

Open http://localhost:8080 and sign in with a Wasmer token. Builds and
gallery entries go to `./data`.

`node test/private_shelf.mjs` checks shelf isolation on plain Node
against a fake registry.

## Deploy

```bash
scripts/deploy.sh
```

It prepares Pi, size-checks the package and runs `wasmer deploy`.

## Runtime notes

These are WASIX/Edge.js behaviours the code works around:

- Pi's credential store needs `utime`; `pi_entry.mjs` uses in-memory credentials and settings.
- Detached process groups fail with `ENOSYS`; the Bash tool uses `detached: false` (`bash_operations.mjs`).
- `fs.cpSync` and `fs.copyFileSync` fail with `EACCES` in the guest; `build.mjs` copies with read/write.
- Pi 0.87.1 needs `npm run prepare:wasmer` to rewrite six Unicode-set regexes for QuickJS.
- A build runs in the instance that received it and streams over that request.
  Events are also written to `/data/builds/<id>/events.ndjson`, so a reload
  can replay them from any instance.
- Pi works in `/tmp`, not on the volume. The volume keeps the archive: input, notes, Pi log, check report, and the final site.
