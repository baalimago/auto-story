# Storybook engine contract

The site is static. `book.js` renders `story.js`, mounts widgets from
`widgets.js` (built in) and optional custom scenes from `scenes.js`, and
loads backdrops from `art/<id>.<artExtension>`. Do not edit `book.js`,
`book.css`, `widgets.js`, or the structure of `index.html`.

## What the reader must always know

The engine makes the teaching explicit, from fields you provide:

- After the cover, a **"What you will find out"** page shows `question` and every idea.
- Each story page shows a label **"Idea 2 of 4 · <idea title>"** from `page.idea`.
- At the end, an **answer** page shows `question`, `answer`, and the ideas as a recap, then the cast.

So choose the question, the answer, and the ideas first; every page then
serves exactly one idea.

## site/story.js

```js
export default {
  title: 'Short book title',
  subtitle: 'One line under the title on the cover',
  byline: 'A picture book about <real topic>',
  question: 'How does a computer find a website from its name?',      // plain words, one sentence
  answer: 'It asks a directory service, then remembers the reply for a while.',
  ideas: [                                                              // 3-5, in teaching order
    { id: 'names', title: 'Names need addresses', text: 'Computers route by numbers, so a name must be turned into an address first.' },
    { id: 'lookup', title: 'Ask the directory', text: 'A resolver asks a chain of servers until one knows the address.' },
    { id: 'cache', title: 'Remember the answer', text: 'The answer is kept for a while, so the next visit skips the lookup.' },
  ],
  palette: { paper: '#f5efe2', ink: '#2e2a25', wash: '#a9d4c6', accent: '#e59f6a' }, // #rrggbb only
  noteLabel: 'For grown-ups',
  artExtension: 'svg',     // only when you draw the backdrops yourself; default 'webp'
  theme: 'watercolor',     // INPUT.look.theme: 'watercolor' | 'comic' | 'manga'
  mono: true,              // only for black & white books; palette must then be greys
  pages: [
    { art: 'cover', side: 'right', text: 'Cover blurb.' },   // page 0 is the cover; no idea
    {
      idea: 'lookup',            // required on every page after the cover
      art: 'p01',                // id from art/plan.json; pages may reuse an id
      side: 'right',             // where the words sit: 'left' | 'right' | 'bottom'
      text: 'Story text. *emphasis*, **strong**. Blank line = new paragraph.',
      alt: 'What the backdrop shows, for screen readers',
      widget: { type: 'stepper', title: '…', steps: [ /* see below */ ] },  // or scene: 'name'
      noteTitle: 'Recursive resolution',
      note: 'The precise explanation with `real_terms` and **key ideas**.',
    },
  ],
  cast: [ { name: 'Old Owl', is: 'The DNS resolver', explain: 'One or two sentences.', art: 'char-owl' } ],
  colophon: 'One closing line for the last page.',
};
```

## Widgets (use these for interaction)

A widget appears on its own card directly below the words, in the same
column, so the other half of the painting stays visible. Widget pages use
`side: 'left'` or `'right'`. Fill it with real content from the document: real words, real
steps, real numbers. Every widget needs a `title` that says what to do or
notice. Pick the widget that makes the page's idea visible:

| Type | Use it for | Fields |
|---|---|---|
| `stepper` | A process that happens in order | `steps: [{ label, caption, chips? }]` (2-8) |
| `squeeze` | Limited room forces a choice; what doesn't fit is lost | `capacity` (1-5), `items: [{ text, important }]` (more than capacity, max 9), `prompt?`, `good`, `bad` |
| `compare` | Before vs after, with vs without, A vs B | `a: { label, caption, chips? }`, `b: { … }` |
| `slider` | More of X changes Y | `label`, `min`, `max`, `step?`, `start?`, `unit?`, `meterLabel?`, `points: [{ at, outcome, meter }]` (2-6, meter 0-100) |
| `quiz` | Check the reader got the idea | `question`, `choices: [{ text, correct, why }]` (2-4, exactly one correct) |

`chips` are short tokens shown as pills: strings, or `{ text, state }`
with state `new` (just added), `ok`, `wrong`, or `dim`.

```js
widget: {
  type: 'stepper', title: 'Watch the summary being written',
  steps: [
    { label: 'Read', caption: 'The whole article is squeezed into one small memory.', chips: ['storm', 'bridge', 'closed'] },
    { label: 'Word 1', caption: 'The writer picks the most likely first word.', chips: [{ text: 'Storm', state: 'new' }] },
    { label: 'Word 2', caption: 'Each new word depends on the words before it.', chips: ['Storm', { text: 'closes', state: 'new' }] },
  ],
}
```

```js
widget: {
  type: 'squeeze', title: 'Fit the letter into the tiny pot', capacity: 2,
  items: [ { text: 'storm', important: true }, { text: 'bridge closed', important: true },
           { text: 'sunny Tuesday', important: false }, { text: 'mayor quoted', important: false } ],
  good: 'The key facts fit, and the rest was left out.',
  bad: 'The pot is full of details; the key fact spilled out.',
}
```

## site/scenes.js (fallback only)

Use a custom scene only when no widget can show the idea, at most two per
book. Export `export default {}` when there are none.

```js
export default {
  sendLetter(api) { /* draw and wire interaction */ },
};
```

Each scene runs when its page opens and is torn down when the reader
leaves. The layer is an SVG with `viewBox="0 0 1500 1000"` laid over the
backdrop. Use only `api`; do not touch `document` or `window`.

| api member | Use |
|---|---|
| `card(title?)` | Paper card in the empty part of the page. Returns a group; draw into it with local coordinates `0..area.w`, `0..area.h`. Use it for every scene. |
| `area` | `{ x, y, w, h }` of that card in scene coordinates. |
| `el(tag, attrs, parent?)` | Create an SVG element. `attrs.text` sets its text. Returns it. |
| `text(str, x, y, attrs?, parent?)` | Centered hand-lettered text, default size 44. |
| `on(target, type, fn)` | Event listener, removed on leave. Add `class: 'hit'` for a pointer cursor. |
| `after(ms, fn)`, `every(ms, fn)` | Timers, cleared on leave. |
| `frame(fn(dt, now))` | Animation loop; return `false` to stop. |
| `animate(el, keyframes, options)` | Web Animations API, cancelled on leave. |
| `point(event)` | Pointer position in scene coordinates. |
| `hint(text)` | Change or clear (`''`) the hint. |
| `palette`, `page`, `svg`, `next()`, `prev()`, `cleanup(fn)` | Helpers. |

## Page text that works

The words must stand alone. The note adds precision, never the meaning.

| Weak (needs the note) | Strong (the metaphor does the work) |
|---|---|
| "The borrowed tricks might help, but this test could not tell." | "Sol baked with Grandma's old recipe book, Nia baked from scratch. The cakes tasted the same, so nobody could say whether the old book helped." |
| "Nia tucked its clues into one little bundle." | "Nia had to fit a whole long letter into one tiny pot. Only the most important words fit; the rest spilled out." |

Name the real concept only in the note and in the cast list.

## site/art/plan.json

```json
{
  "style": "Starts with INPUT.look.directive, then what is specific to this book.",
  "characters": [
    { "id": "olive", "name": "Olive", "look": "A small brown otter, about knee high, with a cream belly, a yellow canvas satchel across her chest and a red scarf." },
    { "id": "bram", "name": "Bram", "look": "A tall old grey heron with round brass glasses and a long blue waistcoat with three buttons." }
  ],
  "images": [
    { "id": "cover", "characters": ["olive", "bram"], "prompt": "Olive and Bram on a river bank at dawn, wide view, the right third is open misty water." }
  ]
}
```

Every character becomes one model sheet at `art/char-<id>.<artExtension>`,
and every image one backdrop at `art/<id>.<artExtension>`: painted by the
coordinator, or drawn by you, as INPUT.art says. Backdrops are painted from
the model sheets of the characters they list, so characters stay the same on
every page. Set `art: 'char-<id>'` on a cast entry to show its model sheet on
the cast page.
