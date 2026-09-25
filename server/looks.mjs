// Visual looks for a book: style, era (year), and colour. The directive leads every image prompt.
const COMIC_ERAS = [
  { from: 1938, to: 1955, label: 'Golden Age', directive: 'Golden Age American comic book art (late 1930s to early 1950s): thick uniform ink outlines, simple heroic poses, flat four-colour printing with Ben-Day dots, slightly misregistered colour on yellowed newsprint' },
  { from: 1956, to: 1969, label: 'Silver Age', directive: 'Silver Age American comic book art (1960s): clean confident brush inking, bold dynamic poses and foreshortening, bright flat primaries, Ben-Day dot shading on newsprint' },
  { from: 1970, to: 1985, label: 'Bronze Age', directive: 'Bronze Age American comic book art (1970s to mid 1980s): more naturalistic anatomy, heavier feathered inking and crosshatching, moodier muted colours, visible newsprint texture' },
  { from: 1986, to: 1999, label: 'Modern Age', directive: 'late-1980s and 1990s modern-age comic book art: gritty detailed linework, dense crosshatching, dramatic chiaroscuro lighting, early computer colouring with gradients' },
  { from: 2000, to: 2026, label: 'Contemporary', directive: 'contemporary digital comic book art (2010s to 2020s): crisp clean line art, painterly digital colouring, cinematic lighting and composition' },
];
const MANGA_ERAS = [
  { from: 1950, to: 1969, label: 'Classic (Tezuka era)', directive: 'classic 1950s to 1960s manga in the Tezuka era: rounded cartoony characters, large expressive eyes, simple clean pen lines, sparse screentone' },
  { from: 1970, to: 1985, label: 'Shōjo and gekiga', directive: '1970s to mid-1980s manga with shōjo and gekiga influence: detailed flowing hair, sparkles and flowers for emotion, dramatic screentone, bold speed lines' },
  { from: 1986, to: 1999, label: 'Golden 90s', directive: 'late-1980s and 1990s manga: sharp angular character designs, heavy layered screentone shading, dynamic action lines and impact effects' },
  { from: 2000, to: 2014, label: 'Digital 2000s', directive: '2000s manga: clean digitally assisted line art, refined screentone gradients, expressive faces and clear staging' },
  { from: 2015, to: 2026, label: 'Modern', directive: 'modern 2020s manga: crisp digital line art, cinematic panel-like framing, subtle digital tones' },
];

export const LOOKS = {
  picturebook: {
    label: 'Watercolor picture book', theme: 'watercolor', defaultColor: 'color',
    directive: "gentle watercolor and ink children's picture book illustration on textured paper, soft edges, loose washes",
  },
  comic: { label: 'Comic book', theme: 'comic', defaultColor: 'color', min: 1938, max: 2026, defaultYear: 1962, eras: COMIC_ERAS },
  manga: { label: 'Manga', theme: 'manga', defaultColor: 'bw', min: 1950, max: 2026, defaultYear: 1995, eras: MANGA_ERAS },
};

const COLORS = {
  color: 'Full colour.',
  bw: 'Black and white only: black ink on white paper, greys only through hatching or screentone, no colour anywhere.',
};

function bad(message) { return Object.assign(new Error(message), { status: 400 }); }

export function parseLook(input = {}) {
  const style = input.style || 'picturebook';
  const look = LOOKS[style];
  if (!look) throw bad(`Unknown style ${style}`);
  const color = input.color || look.defaultColor;
  if (!COLORS[color]) throw bad(`Unknown colour ${color}`);
  let year = null, era = null, directive = look.directive;
  if (look.eras) {
    year = Number(input.year ?? look.defaultYear);
    if (!Number.isInteger(year) || year < look.min || year > look.max) throw bad(`Year must be ${look.min}-${look.max} for ${look.label}`);
    era = look.eras.find(e => year >= e.from && year <= e.to);
    directive = `${era.directive}, as it looked around ${year}`;
  }
  const label = [look.label, era && `${year} (${era.label})`, color === 'bw' ? 'black & white' : 'colour'].filter(Boolean).join(' · ');
  return { style, theme: look.theme, year, color, label, directive: `${directive}. ${COLORS[color]}` };
}

// What the frontend needs to render the controls.
export function lookOptions() {
  return Object.fromEntries(Object.entries(LOOKS).map(([id, l]) => [id, {
    label: l.label, defaultColor: l.defaultColor, min: l.min, max: l.max, defaultYear: l.defaultYear,
    eras: l.eras?.map(({ from, to, label }) => ({ from, to, label })),
  }]));
}
