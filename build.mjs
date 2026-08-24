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

// Deliberately abstract: a photorealistic rendering of a real, current news
// event is a fabricated news photo, so the prompt asks for a flat editorial
// metaphor and rules out photorealism, real faces and text.
function imagePrompt(headline) {
  return [
    'Minimal conceptual editorial illustration for a serious news magazine,',
    'in the style of The Atlantic: one clear visual metaphor, generous negative space,',
    'a restrained muted palette of two or three colours, flat geometric shapes',
    'with a subtle paper grain, quiet and understated.',
    `Interpret this story abstractly rather than literally: "${headline}".`,
    'No text, no lettering, no logos, no recognisable real people, no photorealism,',
    'no gore, no depiction of violence.',
  ].join(' ');
}

async function generateLeadImage(headline) {
  const account = readKey('CF_ACCOUNT_ID');
  const token = readKey('CF_API_TOKEN');
  try {
    const { bytes, ext } =
      account && token
        ? await viaCloudflare(account, token, headline)
        : await viaPollinations(headline);
    const file = `lead.${ext}`;
    writeFileSync(join(ROOT, file), bytes);
    console.log(`lead image -> ${file} (${Math.round(bytes.length / 1024)} KB)`);
    return file;
  } catch (err) {
    // A missing illustration should never cost you the headlines.
    console.error(`Lead image failed (${err.message}) — building without it.`);
    return null;
  }
}

async function viaCloudflare(account, token, headline) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt: imagePrompt(headline), steps: 4 }),
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
async function viaPollinations(headline) {
  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(imagePrompt(headline)) +
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

function render(headlines, at, image, footer) {
  const dateline = at.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const lead = image
    ? `    <figure class="lead">\n      <img src="${escape(image)}" alt="Conceptual illustration for the lead story: ${escape(headlines[0].title)}">\n    </figure>\n`
    : '';

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
  .lead img { display: block; width: 100%; height: auto; }

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
  const image = await generateLeadImage(picks[0].title);

  const footer = `${feedsUsed} feeds · ranked by cross-outlet coverage`;

  const out = join(ROOT, 'index.html');
  writeFileSync(out, render(picks, at, image, footer));
  console.log(`${picks.length} headlines -> ${out}`);
}

try {
  await main();
} catch (err) {
  // Scheduled runs read stderr, not stack traces.
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
