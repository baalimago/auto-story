# Auto Story

Drop a PDF or a text document. Pi reads all of it, writes a checked brief
of its core concepts, scripts a picture book for 10-12 year olds around
them, builds an interactive storybook site, and the builder paints the
characters and pages and deploys the book as a **new Wasmer Edge app**.

```
 browser                         auto-story (Edge app, Edge.js)                      Wasmer / OpenAI
 ───────                         ──────────────────────────────                      ───────────────
 drop PDF ─ pdf.js → text ──POST /api/builds──► workspace /tmp/auto-story/<id>
                                 │  site/ ← agent/template (engine)
 NDJSON progress ◄───────────────┤  Pi child process (/bin/node pi_entry.mjs) ──► builder's model + key
                                 │     writes story.js, scenes.js, art/plan.json
                                 │     runs node /agent/check.mjs until ok
                                 │  check again (no secrets in env)
                                 │  paint character sheets, then backdrops from them ► OpenAI Images
                                 │     (or Pi draws SVG)
                                 │  zip site/ → signed upload → deployViaAutobuild ─► registry.wasmer.io
                                 │  poll build, wait for x-edge-app-version-id
 "Open the book →" ◄─────────────┘  gallery entry → /data/stories/<id>.json
```

## The pipeline

Garbage in, garbage out: the earlier a mistake is caught, the better the
book. So the build is a chain of short, separate Pi sessions
(`server/stages.mjs`), each with its own prompt in `agent/prompts/`. Each
one reads only files in the workspace, and the reviewers get a fresh
session so they judge the files, not the author's reasoning.

| Stage | Agents | Reads | Writes | Gate |
|---|---|---|---|---|
| prepare | – | the upload | `source/part-NN.txt`, `workspace.json` | – |
| understand | analyst, then examiner | every part (or `digests/` for huge documents) | `brief.json`, `reviews/brief-N.json` | `check_plan.mjs --stage brief`: every quote is found verbatim in the part it names, and every part is covered |
| script | writer, then critic | `brief.json` | `script.json`, `reviews/script-N.json` | `--stage script`: every core concept taught, characters have full looks, interactions planned |
| build | builder | `script.json`, `brief.json` | `site/`, `check.json` | `check.mjs` |
| paint | – | `site/art/plan.json`, `check.json` | `site/art/char-<id>.webp`, `site/art/<id>.webp` | – |

- **Whole document.** The document is split into parts of at most 24k
  characters. The analyst must read every part and prove it in
  `brief.coverage` with a quote per part. Documents longer than
  `SINGLE_PASS_CHARS` (default 400k, about 100k tokens) are first digested
  part by part by separate readers, each digest also quote-checked.
- **Adversarial reviews.** The examiner asks at least ten child and expert
  questions of the brief and answers each from the brief and from the
  document; the critic first reads only the page texts, as a 10-12 year old,
  and must be able to explain every core concept from them. A review that
  says `revise` sends the file back to its author, up to `REVIEW_ROUNDS`
  (default 2) times.
- **Characters.** The script fixes a visual model for each character. The
  painter paints one model sheet per character first, then paints every
  backdrop with the images edits endpoint, passing the sheets of the
  characters in it as references, so they look the same on every page. The
  sheets also appear on the cast page. Prompts tell the painter which side
  of each backdrop the words sit on, so it stays calm.
- **Re-running.** `runStages(ctx, { from, to })` re-runs from any stage on
  an existing workspace; `ctx.notes` passes the owner's free-text request to
  the authoring agents as `INPUT.owner_notes`.

Everything above is archived to `/data/builds/<id>/`, with the full transcript of
every agent session in `transcripts/<nn>-<step>.ndjson`: its input, the whole system
prompt, assistant messages with thinking, every tool call with its arguments and full
output, retries, stderr and the exit status. The owner reads them from "Full transcripts"
above the agent log or "Agent transcripts" on each version in the edit view
(`GET /api/builds/<id>/transcripts`, `…/transcripts/<name>.txt` for a readable copy,
`…/transcripts.zip` for everything). Tweaks keep theirs under their own job id.

Agents run in a sandbox with bash, basic file commands and Node only. Every prompt ends
with `agent/prompts/environment.md`, which says so, and every bash command sources
`agent/tools/shell.sh`: Node stand-ins for `grep`/`rg` (`agent/tools/search.mjs`), plain
errors for `python` and friends, and a fix for `node --input-type=module` heredocs, which
Edge.js drops into its REPL. `agent/tools/pages.mjs` prints a script's page texts in order.

`node test/stages.mjs`, `node test/tools.mjs` and `node test/pipeline.mjs` test the validators,
the sandbox tools, the painter and the whole chain offline, with a scripted stand-in for Pi.

## The book format

Every generated app is static: `index.html`, `book.js` and `book.css` are
the engine (`agent/template/`), and Pi writes the rest.

| File | Author | Content |
|---|---|---|
| `story.js` | Pi | Title, palette, pages (text, art id, scene, grown-up note), cast list |
| `scenes.js` | Pi | Interactive SVG scenes on a 1500×1000 layer over the backdrop |
| `art/plan.json` | Pi | Shared style, characters (`id`, `name`, `look`), one prompt per backdrop with the characters in it |
| `art/char-*.webp` | Builder | One model sheet per character, 1024×1024 |
| `art/*.webp` | Builder | Painted with `OPENAI_IMAGE_MODEL`, 1536×1024, from the character sheets, when an OpenAI key is available |
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

## Editing a book (owner only)

Each book on your shelf has an **Edit** link (`#edit/<id>`). It opens the
book's **mood board**, built from the pipeline's own files:

| Card | File | Editing it re-runs |
|---|---|---|
| Core concept: question, answer, concepts, misconceptions | `brief.json` | script → build |
| Characters (with their model sheets) | `script.json` characters | build; the changed sheets and every scene they are in are repainted |
| Plotline: title, story world, ideas, pages | `script.json` | build |
| Scenes (with their backdrops) | `script.json` scenes | build; changed scenes are repainted |

The cards start collapsed, each with a one-line summary; open one to edit its
fields by hand.

Beside the board is **the editor**, a chat with an expert agent
(`agent/prompts/editor.md`, `server/editor_agent.mjs`, `POST /api/stories/<id>/chat`).
It calls your own model directly and edits the board through tools (`edit`,
`set_rebuild_notes`, `mark_repaint`); each change streams back and appears in
its card as it happens. It never touches evidence quotes, facts, coverage or
ids. Nothing is rebuilt until you press **Rebuild the book**, which sends the
edited files as a tweak. Notes for the rebuild reach the agents as
`INPUT.owner_notes`, together with the earlier requests already applied.
"Re-run from" can force an earlier start (re-read the document, or rewrite
the script); by default the run starts at the earliest stage the edits touch.
Ticking **Repaint** on a picture repaints it without running any agent.

A tweak (`server/edit.mjs`) restores the live version into a fresh
workspace, applies the edits, runs the stages, repaints only the pictures
whose plan changed (`planChanges()`: style, character look, scene prompt,
characters in it, or text side), and redeploys to the **same app**, so the
URL never changes. One change runs at a time per book (`tweak.lock`).

Every build, tweak and rollback is a version (`server/versions.mjs`):

```
/data/builds/<book id>/versions/<nnnn>/
  version.json   kind, who, when, message, what changed, what was repainted
  site/          exactly what was deployed
  work/          brief.json, script.json, notes.md, check.json, reviews/
```

Rolling back redeploys an old version's site as a new version, so nothing
is lost. Books made before mood boards existed can be rolled back but not
tweaked. Endpoints: `GET /api/stories/<id>/board`,
`POST /api/stories/<id>/tweaks`, `POST /api/stories/<id>/rollback`; all
check that the book is on the caller's shelf, and tweak and rollback events
stream like builds.

## Configuration

| Name | Kind | Purpose |
|---|---|---|
| `OPENAI_IMAGE_MODEL` | env | Default `gpt-image-1`. `OPENAI_IMAGE_QUALITY` defaults to `medium`. |
| `STORY_OWNER` | env | Optional namespace for books instead of the visitor's own account. |
| `MAX_ACTIVE_BUILDS` | env | Per instance, default 2. |
| `PI_TIMEOUT_SECONDS` | env | Per agent session, default 1500. |
| `MAX_DOCUMENT_CHARS` | env | Longer documents are trimmed, default 1,500,000. |
| `SINGLE_PASS_CHARS` | env | Longer documents are digested part by part first, default 400,000. |
| `REVIEW_ROUNDS` | env | Revisions the examiner and critic may ask for, default 2. |

## Run locally

```bash
npm ci --prefix pi --ignore-scripts --no-bin-links --no-audit --no-fund
npm run --prefix pi prepare:wasmer
scripts/dev.sh
```

Open http://localhost:8080 and sign in with a Wasmer token. Builds and
gallery entries go to `./data`.

`node test/edit.mjs` runs a build, tweaks, a repaint and a rollback
against a fake Pi, painter and registry.

`node test/private_shelf.mjs` checks shelf isolation on plain Node
against a fake registry.

## Deploy

Two ways, both run `server/server.mjs`:

- **Git deploys** (pushing to master when the Wasmer app is connected to the
  repo). Wasmer builds with [Anybuild](https://github.com/wasmerio/anybuild),
  which reads the root `Anybuild` file: a Node app on Edge.js (QuickJS) plus
  bash, whose `npm run build` installs and trims Pi
  (`scripts/prepare-pi.mjs`). Without that file Anybuild sees
  `public/index.html` and deploys a static site, and the page then reports
  that its server is not answering.
- **`scripts/deploy.sh`** from a checkout. It prepares Pi, size-checks the
  package and runs `wasmer deploy` with `wasmer.toml`.

The server finds its files either way: `/public`, `/agent` and `/pi` under
`wasmer.toml`, or `public/`, `agent/` and `pi/` next to `server/` when the
repo runs in place (`server/config.mjs`).

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
