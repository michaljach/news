#!/usr/bin/env node
// Builds a static page of current headlines.
//
// Everything factual comes from publisher RSS feeds: real titles, real article
// URLs, real publication names. That removes the hallucinated-URL problem and
// the search-grounding quota that metered every LLM route.
//
// Which five stories lead is decided by how many independent outlets ran the
// story, so ranking needs no API and has no quota. The only model call left is
// the lead illustration, and failing it costs nothing but the picture.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const COUNT = Number(process.env.NEWS_COUNT ?? 5);
const FEED_TIMEOUT_MS = Number(process.env.FEED_TIMEOUT_MS ?? 20_000);
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 180_000);
const UA = 'Mozilla/5.0 (compatible; news-page/1.0)';

const FEEDS = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-world' },
  { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
];

function readKey(...names) {
  for (const name of names) if (process.env[name]) return process.env[name];
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trimStart().startsWith('#')) continue;
    if (!names.includes(line.slice(0, eq).trim())) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return null;
}

// --- RSS ------------------------------------------------------------------

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagText(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeEntities(m[1]) : null;
}

function itemLink(block) {
  const plain = tagText(block, 'link');
  if (plain && /^https?:/i.test(plain)) return plain;
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return decodeEntities(href[1]);
  const guid = tagText(block, 'guid');
  if (guid && /^https?:/i.test(guid)) return guid;
  return null;
}

// Feeds mix reporting with newsletters, opinion and lifestyle. A headlines page
// wants the reporting, so digests like "Up First" and "First Thing" are dropped.
const SKIP_TITLE =
  /\b(first thing|up first|morning mail|weekend edition|newsletter|the guardian view|opinion|editorial|podcast|quiz|crossword|recipe|horoscope|what to watch|best photos|in pictures)\b/i;

const SKIP_URL =
  /\/(newsletters?|up-first|first-thing|opinion|commentisfree|podcasts?|crosswords?|lifeandstyle|food|fashion|travel|sport|football|games|tv-and-radio|culture|books|music)\//i;

function parseFeed(xml, fallbackSource) {
  const items = [];
  const re = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const title = tagText(block, 'title');
    const url = itemLink(block);
    if (!title || !url) continue;

    // Feeds vary: "Headline - Publisher", trailing whitespace, stray periods.
    // Only strip a final period when it is not part of an abbreviation, so
    // "tariffs on U.S." does not become "tariffs on U.S".
    const clean = title
      .replace(/\s+[-–|]\s+[^-–|]{2,30}$/, '')
      .replace(/(?<![A-Z])\.$/, '')
      .trim();
    if (clean.length < 15) continue;
    if (SKIP_TITLE.test(clean) || SKIP_URL.test(url)) continue;

    items.push({
      title: clean,
      url,
      source: tagText(block, 'source') || fallbackSource,
      date: Date.parse(tagText(block, 'pubDate') ?? tagText(block, 'dc:date') ?? '') || 0,
      pos: items.length,
    });
  }
  return items;
}

async function fetchFeeds() {
  const results = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const res = await fetch(feed.url, {
          headers: { 'user-agent': UA },
          redirect: 'follow',
          signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseFeed(await res.text(), feed.name);
      } catch (err) {
        // One dead feed should never fail the build.
        console.error(`feed ${feed.name} unavailable (${err.message})`);
        return [];
      }
    })
  );

  const live = results.filter((r) => r.length).length;
  return { items: results.flat(), feedsUsed: live };
}

const STOPWORDS = new Set(
  ('a an the of in on at to for from by with and or as is are was were be been after over into ' +
   'amid says say said new more than its his her their our up down out off about not no').split(' ')
);

const keyWords = (title) =>
  new Set(
    title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  );

// Group headlines that describe the same event. The cluster signature stays
// fixed to the first headline's words; letting it grow would make a cluster
// match everything after a few merges.
function cluster(items) {
  const clusters = [];
  for (const item of items.sort((a, b) => b.date - a.date)) {
    const words = keyWords(item.title);
    if (!words.size) continue;

    const hit = clusters.find((c) => {
      const shared = [...words].filter((w) => c.words.has(w)).length;
      return shared / Math.min(words.size, c.words.size) > 0.45;
    });

    if (hit) {
      hit.items.push(item);
      hit.sources.add(item.source);
    } else {
      clusters.push({ items: [item], sources: new Set([item.source]), words });
    }
  }
  return clusters;
}

// Importance without a model: how many independent outlets ran the story, then
// how prominently they placed it, then how fresh it is. Corroboration is the
// signal a single feed's ordering cannot give you, and it costs nothing.
function scoreCluster(c, newest) {
  const corroboration = c.sources.size * 100;
  const prominence = Math.max(0, 30 - Math.min(...c.items.map((i) => i.pos)) * 2);
  const freshest = Math.max(...c.items.map((i) => i.date));
  const hoursOld = freshest ? (newest - freshest) / 3_600_000 : 48;
  const recency = Math.max(0, 40 - hoursOld * 2);
  return corroboration + prominence + recency;
}

// Cap any one outlet so a prolific feed cannot fill the page on its own.
function selectTopStories(items) {
  const newest = Math.max(...items.map((i) => i.date).filter(Boolean), Date.now());
  const ranked = cluster(items)
    .map((c) => ({ ...c, score: scoreCluster(c, newest) }))
    .sort((a, b) => b.score - a.score);

  const maxPerSource = Math.max(1, Math.ceil(COUNT / 2));
  const used = new Map();
  const picks = [];

  for (const pass of [maxPerSource, COUNT]) {
    for (const c of ranked) {
      if (picks.length >= COUNT) break;
      // Represent the cluster with its most prominently placed headline.
      const best = c.items.slice().sort((a, b) => a.pos - b.pos)[0];
      if (picks.includes(best)) continue;
      const count = used.get(best.source) ?? 0;
      if (count >= pass) continue;
      used.set(best.source, count + 1);
      picks.push(best);
    }
    if (picks.length >= COUNT) break;
  }

  return picks.slice(0, COUNT);
}

// --- lead image -----------------------------------------------------------

// Two saturated accents against pure black, rotated so consecutive pulls do not
// look identical. Index is derived from the clock, not random, so a rebuild of
// the same hour reproduces the same artwork.
const PALETTES = [
  { dark: '#2f7d32', light: '#e2f1e3', field: '#e8563f', wash: '#fbe3dc' },
  { dark: '#2a5fc4', light: '#e4ecfc', field: '#e8a33f', wash: '#fdf0d9' },
  { dark: '#127f86', light: '#ddf0f1', field: '#d95f2b', wash: '#fbe4d6' },
  { dark: '#a3243c', light: '#fbe6ea', field: '#c9c93f', wash: '#f7f7dc' },
];

// Used when no model is reachable. Crude next to a generated metaphor, but it
// keeps the artwork tied to the story instead of falling back to a generic blob.
const MOTIFS = [
  [/missile|strike|\bwar\b|military|troops|army|weapon|offensive|bomb|nuclear/i,
   'two missiles rising steeply through broken cloud'],
  [/election|vote|ballot|poll|referendum|campaign/i,
   'a single folded ballot paper falling into a dark slot'],
  [/tariff|trade|econom|market|bond|inflation|currency|export|bank/i,
   'stacked shipping containers arranged like a bar chart'],
  [/climate|flood|storm|wildfire|drought|heat|hurricane|cyclone|quake/i,
   'a cracked dry riverbed running to the horizon'],
  [/virus|disease|epidemic|outbreak|mpox|health|hospital|medical|vaccine/i,
   'a blister pack of pills with one capsule missing'],
  [/court|trial|prison|sentenc|convict|jail|judge|lawsuit|charged/i,
   'an empty wooden chair in a shaft of hard light'],
  [/protest|rally|strike|march|demonstrat|riot/i,
   'a dense forest of raised bare flagpoles'],
  [/\boil\b|petrol|\bgas\b|energy|fuel|pipeline|power grid/i,
   'a lone oil drum casting a long hard shadow'],
  [/satellite|rocket|space|orbit|launch/i,
   'a satellite dish tilted up at an empty sky'],
  [/\bai\b|chip|data|tech|software|cyber|digital|online|social media/i,
   'a fractured circuit board lit hard from one side'],
  [/border|migrant|refugee|asylum|deport|visa/i,
   'a chain-link fence dissolving into open sky'],
  [/king|queen|royal|palace|monarch|prince/i,
   'an empty ceremonial chair beneath a tall window'],
  [/cricket|football|olympic|tournament|match|eurovision|contest/i,
   'a worn leather ball alone on an empty pitch'],
  [/talks|summit|treaty|diploma|negotiat|alliance/i,
   'two chairs facing each other across a long empty table'],
];

function fallbackConcept(headline) {
  for (const [pattern, motif] of MOTIFS) if (pattern.test(headline)) return motif;
  return 'a single folded newspaper lying on an empty table';
}

// One short completion turns a headline into a photographable metaphor. This is
// plain generation, the generous half of every free tier, and it degrades to the
// motif table rather than failing the build.
async function conceptFor(headline) {
  const key = readKey('GROQ_API_KEY');
  if (!key) return fallbackConcept(headline);

  const prompt =
    `Newspaper headline: "${headline}"\n\n` +
    'Invent one striking visual metaphor an editorial art director could photograph ' +
    'for this story. It must be a single concrete physical object or scene. ' +
    'No people, no faces, no text, no logos, no maps, no flags of real countries. ' +
    'Reply with the subject only, under 15 words, no trailing punctuation.';

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.8,
        // gpt-oss spends completion tokens on reasoning before it writes any
        // content, so a tight cap silently truncates the answer mid-phrase.
        max_tokens: 700,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);

    const choice = (await res.json()).choices?.[0] ?? {};
    if (choice.finish_reason === 'length') throw new Error('concept truncated');
    const text = choice.message?.content ?? '';
    const concept = text.trim().replace(/^["']|["'.]+$/g, '').split('\n')[0].trim();
    if (concept.length < 8 || concept.length > 120) throw new Error('unusable concept');
    return concept;
  } catch (err) {
    console.error(`Concept step failed (${err.message}) — using motif table.`);
    return fallbackConcept(headline);
  }
}

// The model supplies only a clean subject photograph. Duotone, grain and the
// block layout are applied deterministically in SVG at render time, because a
// diffusion model will not reliably honour a compositional brief — asking for
// one produced a soft blob with none of the intended structure.
//
// Treating a symbolic object as a silkscreen is what keeps this editorial
// artwork rather than a fabricated news photo; real people and text stay out.
function imagePrompt(concept) {
  return [
    `Editorial still-life photograph of ${concept}.`,
    'Single clear subject, centred, plain seamless studio background,',
    'dramatic hard side lighting, deep shadows, high contrast, sharp focus,',
    'minimal and graphic.',
    'No text, no lettering, no numbers, no logos, no watermarks,',
    'no people, no faces, no gore.',
  ].join(' ');
}

const channel = (hex, i) => (parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255).toFixed(3);

// Duotone via luminance then a two-stop transfer table. The split between the
// black field and the colour field is a hard vertical edge; the organic shapes
// live inside the colour field, not on its boundary. Grain is one overlay pass
// across the whole canvas — in `overlay` mode it leaves pure black untouched and
// bites only on the colour field and the photograph, which is what the printed
// reference does. All native SVG filters, so no image library is involved.
function leadArtwork(art) {
  const { palette, seed, label } = art;
  const table = (i) => `${channel(palette.dark, i)} ${channel(palette.light, i)}`;
  return `<svg class="art" viewBox="0 0 1536 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escape(label)}">
      <defs>
        <filter id="duotone" color-interpolation-filters="sRGB">
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer>
            <feFuncR type="table" tableValues="${table(0)}"/>
            <feFuncG type="table" tableValues="${table(1)}"/>
            <feFuncB type="table" tableValues="${table(2)}"/>
          </feComponentTransfer>
        </filter>
        <filter id="mottle" x="-30%" y="-30%" width="160%" height="160%">
          <feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves="5" seed="${seed}"/>
          <feColorMatrix type="luminanceToAlpha"/>
          <feComponentTransfer result="mask">
            <feFuncA type="discrete" tableValues="0 0 0 1 1"/>
          </feComponentTransfer>
          <feFlood flood-color="${palette.wash}" result="wash"/>
          <feComposite in="wash" in2="mask" operator="in"/>
        </filter>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="3" stitchTiles="stitch" seed="${seed}"/>
          <feColorMatrix type="saturate" values="0"/>
        </filter>
        <clipPath id="field"><rect x="768" y="0" width="768" height="1024"/></clipPath>
      </defs>

      <rect width="1536" height="1024" fill="#000"/>

      <g clip-path="url(#field)">
        <rect x="768" y="0" width="768" height="1024" fill="${palette.field}"/>
        <rect x="700" y="-120" width="920" height="1280" fill="${palette.wash}" filter="url(#mottle)"/>
      </g>

      <image href="${art.file}" x="140" y="272" width="524" height="400"
             preserveAspectRatio="xMidYMid slice" filter="url(#duotone)"/>

      <rect width="1536" height="1024" filter="url(#grain)" opacity="0.55"
            style="mix-blend-mode:overlay"/>
    </svg>`;
}

async function generateLeadImage(headline) {
  const account = readKey('CF_ACCOUNT_ID');
  const token = readKey('CF_API_TOKEN');

  const concept = await conceptFor(headline);
  const slot = Math.floor(Date.now() / 7_200_000);
  const palette = PALETTES[slot % PALETTES.length];
  const prompt = imagePrompt(concept);
  console.log(`lead concept: ${concept}`);

  try {
    const { bytes, ext } =
      account && token
        ? await viaCloudflare(account, token, prompt)
        : await viaPollinations(prompt);
    const file = `lead.${ext}`;
    writeFileSync(join(ROOT, file), bytes);
    console.log(`lead image -> ${file} (${Math.round(bytes.length / 1024)} KB)`);
    return { file, palette, seed: slot % 100, label: `Editorial illustration: ${concept}` };
  } catch (err) {
    // A missing illustration should never cost you the headlines.
    console.error(`Lead image failed (${err.message}) — building without it.`);
    return null;
  }
}

async function viaCloudflare(account, token, prompt) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt, steps: 4 }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    }
  );
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  const b64 = data.result?.image;
  if (!b64) throw new Error('Cloudflare returned no image');
  return { bytes: Buffer.from(b64, 'base64'), ext: 'png' };
}

// No key, no account. Slower and lower fidelity than Cloudflare, but it means
// the page builds on a clean machine with nothing configured.
async function viaPollinations(prompt) {
  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt) +
    '?width=1536&height=1024&nologo=true';
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Pollinations ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length < 2000) throw new Error('Pollinations returned an empty image');
  return { bytes, ext: res.headers.get('content-type')?.includes('png') ? 'png' : 'jpg' };
}

// --- render ---------------------------------------------------------------

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function render(headlines, at, art, footer) {
  const dateline = at.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const lead = art ? `    <figure class="lead">\n      ${leadArtwork(art)}\n    </figure>\n` : '';

  const stories = headlines
    .map(({ title, source, url }) => {
      const heading = url
        ? `<a href="${escape(url)}" rel="noopener">${escape(title)}</a>`
        : escape(title);
      const byline = source ? `\n        <p class="meta source">${escape(source)}</p>` : '';
      return `      <article class="story">\n        <h2>${heading}</h2>${byline}\n      </article>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latest News</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }

  body {
    margin: 0;
    min-height: 100svh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: clamp(2.5rem, 8vw, 6rem) 1.5rem;
    background: #fff;
    color: #000;
    font-family: "Playfair Display", "Iowan Old Style", Georgia, "Times New Roman", serif;
    -webkit-font-smoothing: antialiased;
  }

  main { width: 100%; max-width: 38rem; }

  .meta {
    margin: 0;
    text-align: center;
    font-family: ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .dateline {
    margin-bottom: clamp(2.5rem, 7vw, 4rem);
    font-size: 0.68rem;
  }

  .lead { margin: 0 0 clamp(1.75rem, 4.5vw, 2.75rem); }
  .lead .art { display: block; width: 100%; height: auto; }

  .story { padding: clamp(1.4rem, 3.5vw, 2rem) 0; text-align: center; }
  .story h2 {
    margin: 0;
    font-size: clamp(1.3rem, 3.4vw, 1.75rem);
    font-weight: 500;
    line-height: 1.3;
    text-wrap: balance;
  }
  .story a { color: inherit; text-decoration: none; }
  .story a:hover {
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.2em;
  }
  .story a:focus-visible { outline: 2px solid #000; outline-offset: 4px; }

  .source { margin: 0.7rem 0 0; font-size: 0.66rem; }

  footer {
    margin-top: clamp(2.5rem, 7vw, 4rem);
    font-size: 0.62rem;
  }
</style>
</head>
<body>
  <main>
    <p class="meta dateline">${escape(dateline)} &middot; ${escape(time)}</p>

${lead}
${stories}

    <footer class="meta">${escape(footer)}</footer>
  </main>
</body>
</html>
`;
}

// --- main -----------------------------------------------------------------

async function main() {
  const at = new Date();

  const { items, feedsUsed } = await fetchFeeds();
  if (!items.length) throw new Error('no feed returned any stories');
  console.log(`${items.length} stories from ${feedsUsed}/${FEEDS.length} feeds`);

  const picks = selectTopStories(items);
  if (!picks.length) throw new Error('no stories survived filtering');
  const art = await generateLeadImage(picks[0].title);

  const footer = `${feedsUsed} feeds · ranked by cross-outlet coverage`;

  const out = join(ROOT, 'index.html');
  writeFileSync(out, render(picks, at, art, footer));
  console.log(`${picks.length} headlines -> ${out}`);
}

try {
  await main();
} catch (err) {
  // Scheduled runs read stderr, not stack traces.
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
