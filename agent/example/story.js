// Example book about DNS. Shows the shape the engine reads: question, answer, ideas, one idea per page, widgets.
export default {
  title: 'Pip and the Great Address Book',
  subtitle: 'How does a computer find a website from its name?',
  byline: 'A picture book about DNS',
  question: 'How does a computer find a website when all you give it is a name?',
  answer: 'It asks a chain of helpers to turn the name into a number address, then remembers the answer for a while so the next trip is quick.',
  ideas: [
    { id: 'numbers', title: 'Names need numbers', text: 'Networks deliver to number addresses, so a name like otter.bakery must be turned into a number first.' },
    { id: 'chain', title: 'Ask a chain of helpers', text: 'No single helper knows every address, so the question is passed from the root, to .bakery, to the bakery itself.' },
    { id: 'remember', title: 'Remember for a while', text: 'The answer is written down with an expiry time, so repeat trips skip the whole chain until it runs out.' },
  ],
  palette: { paper: '#f5efe2', ink: '#2e2a25', wash: '#a9d4c6', accent: '#e59f6a' },
  noteLabel: 'For grown-ups',
  theme: 'watercolor',
  pages: [
    { art: 'cover', side: 'right', text: 'Pip the pigeon carries letters all over Byte Valley. But nobody in Byte Valley lives at a name.' },
    {
      idea: 'numbers', art: 'p01', side: 'right',
      text: 'Pip wanted to visit *Otter Bakery*. But Byte Valley houses only have numbers on their doors, and Pip only knew the name.',
      note: 'Computers on the internet are reached by **IP addresses** such as `93.184.216.34`. People use names like `otter.bakery`. DNS turns one into the other.',
    },
    {
      idea: 'numbers', art: 'p01', side: 'left',
      text: 'A letter with only a name on it could go to any door. With the number, it goes to exactly one.',
      widget: {
        type: 'compare', title: 'What can the post deliver?',
        a: { label: 'Name only', caption: 'Hundreds of doors, no names on them. The letter cannot be delivered.', chips: ['otter.bakery', { text: 'door ?', state: 'wrong' }] },
        b: { label: 'Number', caption: 'The number matches exactly one door. Delivered!', chips: ['93.184.216.34', { text: 'door 34', state: 'ok' }] },
      },
      note: 'Routers forward packets by **IP address** only. A name has to be resolved before the first packet is sent.',
    },
    {
      idea: 'chain', art: 'p02', side: 'right',
      text: 'Old Owl did not know every house. But she knew who to ask, and they knew who to ask next.',
      widget: {
        type: 'stepper', title: 'Follow the question up the chain',
        steps: [
          { label: 'Ask Old Owl', caption: 'Pip asks the local helper: where is otter.bakery?', chips: [{ text: 'otter.bakery?', state: 'new' }] },
          { label: 'The root', caption: 'The root does not know the bakery, but knows who looks after every .bakery name.', chips: ['otter.bakery?', { text: 'ask .bakery', state: 'new' }] },
          { label: '.bakery helper', caption: 'The .bakery helper points to the bakery\'s own address keeper.', chips: ['otter.bakery?', 'ask .bakery', { text: 'ask otter', state: 'new' }] },
          { label: 'The answer', caption: 'Otter Bakery\'s keeper gives the number. Old Owl hands it to Pip.', chips: [{ text: '93.184.216.34', state: 'ok' }] },
        ],
      },
      noteTitle: 'Recursive resolution',
      note: 'Your **resolver** asks a **root server**, which refers it to the **TLD server** for `.bakery`, which refers it to the domain\'s **authoritative server**, which returns the **A record**.',
    },
    {
      idea: 'chain', art: 'p02', side: 'left',
      text: 'Each helper only has to know a small part of the valley. Together they know all of it.',
      note: 'DNS is split into **zones**. Each server is authoritative only for its zone and delegates the rest, so no single machine holds every name.',
    },
    {
      idea: 'remember', art: 'p03', side: 'right',
      text: 'Old Owl wrote the number on Pip\'s wing in ink that slowly fades. Until it faded, Pip could fly straight there.',
      widget: {
        type: 'slider', title: 'How long should the ink last?', label: 'Ink lasts', min: 1, max: 48, unit: 'hours', start: 1, meterLabel: 'Trips that skip the owl',
        points: [
          { at: 1, outcome: 'Pip asks the owl almost every trip: always fresh, but slow.', meter: 15 },
          { at: 12, outcome: 'Most trips skip the owl, and a moved bakery is noticed by evening.', meter: 70 },
          { at: 48, outcome: 'Pip nearly never asks, but if the bakery moves, Pip flies to the old door for two days.', meter: 97 },
        ],
      },
      noteTitle: 'Caching and TTL',
      note: 'Each answer carries a **TTL** (time to live). Resolvers and browsers **cache** it until the TTL expires. Long TTLs mean fewer lookups but slower updates.',
    },
    {
      idea: 'remember', art: 'p03', side: 'left',
      text: 'One day the bakery moved to a new door. Pip kept flying to the old one until the ink faded, then asked Old Owl again.',
      note: 'A cached record keeps pointing to the **old IP** until its TTL runs out, which is why DNS changes "take time to propagate".',
    },
    {
      idea: 'chain', art: 'p02', side: 'right',
      text: 'Now Pip knows the whole trick. Can you?',
      widget: {
        type: 'quiz', title: 'Quick check', question: 'Pip has a fresh number on his wing. What happens on his next trip?',
        choices: [
          { text: 'He asks Old Owl again', correct: false, why: 'Only when the ink has faded. Until then the remembered number is used.' },
          { text: 'He flies straight to the number', correct: true, why: 'The cached answer is still valid, so the whole chain is skipped.' },
          { text: 'He asks the root helper', correct: false, why: 'The root is only asked when nobody nearby remembers the answer.' },
        ],
      },
    },
  ],
  cast: [
    { name: 'Pip the pigeon', is: 'Your browser', explain: 'Wants to reach a site by its name.' },
    { name: 'Old Owl', is: 'The DNS resolver', explain: 'Asks the chain of helpers on your behalf and remembers answers.' },
    { name: 'The helpers', is: 'Root, TLD, and authoritative servers', explain: 'Each knows one part of the naming tree and points to the next.' },
    { name: 'Ink on the wing', is: 'The DNS cache and its TTL', explain: 'A remembered answer that expires after a while.' },
  ],
  colophon: 'Written by Pi, painted by a machine, served from Wasmer Edge.',
};
