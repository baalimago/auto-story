export const LIMITS = {
  minPages: 8,
  maxPages: 14,
  maxTextChars: 280,
  maxImages: 12,
  minInteractions: 3,
  maxFreeformScenes: 2,
  minIdeas: 3,
  maxIdeas: 5,
  minCast: 3,
  minPromptChars: 60,
  maxNoteChars: 900,
};

export const ENGINE_FILES = ['index.html', 'book.js', 'book.css', 'widgets.js', 'powered-by-wasmer.svg'];
export const AUTHORED_FILES = ['story.js', 'scenes.js', 'story.css', 'art/plan.json'];

export const MAX_SVG_BYTES = 250_000;

// Rendered into INPUT.art; the system prompt only says "follow INPUT.art.instructions".
export const ART_MODES = {
  painted: {
    mode: 'painted',
    instructions: [
      'The coordinator paints every art/plan.json image after you finish, landscape 3:2.',
      'It prepends INPUT.look.directive, plan.style and plan.characters to each prompt, so a prompt only describes its own scene.',
      'Describe composition only. Keep the words side of that page calm and mostly empty.',
      'Ask for no text, letters, labels, or numbers inside backdrops.',
      'Leave story.artExtension unset.',
    ],
  },
  svg: {
    mode: 'svg',
    instructions: [
      'No image model is available. Draw every art/plan.json image yourself as site/art/<id>.svg.',
      'Use viewBox="0 0 1500 1000" and draw in the idiom of INPUT.look, with the story palette.',
      'Reference the page filters url(#wc-wash) and url(#wc-edge) only inside inline SVG scenes; backdrop files must define their own filters.',
      'Give each backdrop the texture of its look: a feTurbulence edge for watercolor, halftone dot patterns for comics, line hatching or screentone patterns for manga.',
      `Keep each file under ${Math.round(MAX_SVG_BYTES / 1000)} kB, with no <script>, no <image>, and no external references.`,
      'Keep the words side of that page calm and mostly empty.',
      "Set story.artExtension to 'svg'.",
    ],
  },
};

// Rendered into INPUT.look.instructions; the chosen look comes from the builder's UI.
export const LOOK_INSTRUCTIONS = [
  'Every visual choice follows INPUT.look.directive: the art plan, SVG drawings, scenes, palette, and story.css.',
  'Start plan.style with INPUT.look.directive, then add what is specific to this book. Never contradict it.',
  'Set story.theme to INPUT.look.theme. When INPUT.look.color is "bw", set story.mono to true and use only black, white and greys in the palette and scenes.',
  'Draw scenes in the same idiom: bold inked outlines and halftone dots for comics, clean pen lines and screentone for manga, soft washes for picture books.',
  'Keep the story gentle and clear whatever the look.',
];
