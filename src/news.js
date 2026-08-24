import jpeg from 'jpeg-js';

// Shared, environment-free logic for the news page.
//
// Imported by build.mjs (local preview, writes files) and src/worker.js
// (Cloudflare, cron-driven). Nothing here touches the filesystem, process.env
// or any Node built-in, so the same code runs in both.

export const COUNT = 5;
export const FEED_TIMEOUT_MS = 20_000;
export const TIMEZONE = 'Europe/Warsaw';

export const ABOUT =
  'Every two hours this page pulls six publisher feeds and ranks the day\'s ' +
  'stories by how many independent outlets ran each one.';

export const AUTHOR = { handle: '@michaeljach', url: 'https://x.com/michaeljach' };
export const SITE = 'https://news.jach.me';

// Static, so a shared link does not read as an endorsement of whichever story
// happened to lead when the card was scraped.
export const CARD_TITLE = `${COUNT} current world news`;


export const UA = 'Mozilla/5.0 (compatible; news-page/1.0)';

export const FEEDS = [
  { name: 'BBC News', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'The Guardian', url: 'https://www.theguardian.com/world/rss' },
  { name: 'NPR', url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-world' },
  { name: 'Sky News', url: 'https://feeds.skynews.com/feeds/rss/world.xml' },
];

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

export function parseFeed(xml, fallbackSource) {
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

export async function fetchFeeds() {
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

// Stories accumulate over the day rather than being re-derived from each pull.
// Corroboration is the ranking signal, and it only becomes meaningful with time:
// a single snapshot catches one outlet on a story that six will have run by
// evening.
export const MAX_DAY_ITEMS = 900;

// en-CA formats as YYYY-MM-DD. Bucketing by the display timezone means "today"
// on the page matches the day the reader is actually having.
export function dayKey(at, timeZone = TIMEZONE) {
  return at.toLocaleDateString('en-CA', { timeZone });
}

// First sighting wins, so a story keeps the publication time it broke with
// rather than being refreshed to the latest pull.
export function mergeItems(existing, fresh) {
  const byUrl = new Map();
  for (const item of existing) {
    if (item?.url && item.title) byUrl.set(item.url, item);
  }
  for (const item of fresh) {
    if (item?.url && item.title && !byUrl.has(item.url)) byUrl.set(item.url, item);
  }
  return [...byUrl.values()].sort((a, b) => b.date - a.date).slice(0, MAX_DAY_ITEMS);
}

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
export const DAY_WINDOW_HOURS = 30;

export function selectTopStories(items) {
  const newest = Math.max(...items.map((i) => i.date).filter(Boolean), Date.now());

  const scored = cluster(items)
    .map((c) => ({
      ...c,
      score: scoreCluster(c, newest),
      freshest: Math.max(...c.items.map((i) => i.date)),
    }))
    .sort((a, b) => b.score - a.score);

  // Feeds carry evergreen pieces days old, which are not "today" by any reading.
  // Filtering the cluster rather than the article means a story that is still
  // being covered keeps every outlet that ever ran it, while one that has gone
  // quiet drops out. Falls back to the full set if a thin day would leave gaps.
  const withinDay = scored.filter(
    (c) => !c.freshest || (newest - c.freshest) / 3_600_000 <= DAY_WINDOW_HOURS
  );
  const ranked = withinDay.length >= COUNT ? withinDay : scored;

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
// One red duotone. The rotation that used to live here paired a photo tone with
// the abstract colour field; that field is gone, so there is nothing to pair.
export const DUOTONE = { dark: '#8e1f2f', light: '#f4e3e2' };
export const ART_WIDTH = 1024;
export const ART_HEIGHT = 768;
const GRAIN = 0.17;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// Bakes the duotone and grain into the pixels rather than leaving them to SVG
// filters. Social crawlers fetch og:image as a flat file and will not run
// filters, so the stored JPEG has to already be the finished artwork.
//
// Same maths the SVG did: luminance drives a two-stop colour ramp. The centre
// crop to 4:3 replaces preserveAspectRatio="slice".
export function treat(bytes) {
  const src = jpeg.decode(bytes, { useTArray: true });
  const scale = Math.max(ART_WIDTH / src.width, ART_HEIGHT / src.height);
  const [dr, dg, db] = rgb(DUOTONE.dark);
  const [lr, lg, lb] = rgb(DUOTONE.light);

  const out = new Uint8Array(ART_WIDTH * ART_HEIGHT * 4);
  const offX = (src.width - ART_WIDTH / scale) / 2;
  const offY = (src.height - ART_HEIGHT / scale) / 2;

  for (let y = 0; y < ART_HEIGHT; y++) {
    const sy = Math.min(src.height - 1, Math.round(offY + y / scale));
    for (let x = 0; x < ART_WIDTH; x++) {
      const sx = Math.min(src.width - 1, Math.round(offX + x / scale));
      const si = (sy * src.width + sx) * 4;

      const lum =
        (src.data[si] * 0.2126 + src.data[si + 1] * 0.7152 + src.data[si + 2] * 0.0722) / 255;
      const t = Math.min(1, Math.max(0, lum + (Math.random() - 0.5) * GRAIN));

      const di = (y * ART_WIDTH + x) * 4;
      out[di] = dr + (lr - dr) * t;
      out[di + 1] = dg + (lg - dg) * t;
      out[di + 2] = db + (lb - db) * t;
      out[di + 3] = 255;
    }
  }

  return jpeg.encode({ data: out, width: ART_WIDTH, height: ART_HEIGHT }, 82).data;
}

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

export function conceptPrompt(headline) {
  return (
    `Newspaper headline: "${headline}"\n\n` +
    'Invent one striking visual metaphor an editorial art director could photograph ' +
    'for this story. It must be a single concrete physical object or scene. ' +
    'No people, no faces, no text, no logos, no maps, no flags of real countries. ' +
    'Reply with the subject only, under 15 words, no trailing punctuation.'
  );
}

// Accepts whatever a model returned and decides whether it is usable.
export function cleanConcept(text) {
  const concept = (text ?? '').trim().replace(/^["']|["'.]+$/g, '').split('\n')[0].trim();
  return concept.length >= 8 && concept.length <= 120 ? concept : null;
}

export function fallbackConcept(headline) {
  for (const [pattern, motif] of MOTIFS) if (pattern.test(headline)) return motif;
  return 'a single folded newspaper lying on an empty table';
}

// One short completion turns a headline into a photographable metaphor. This is
// plain generation, the generous half of every free tier, and it degrades to the
// motif table rather than failing the build.

export function imagePrompt(concept) {
  return [
    `Editorial still-life photograph of ${concept}.`,
    'Single clear subject, centred, plain seamless studio background,',
    'dramatic hard side lighting, deep shadows, high contrast, sharp focus,',
    'minimal and graphic.',
    'No text, no lettering, no numbers, no logos, no watermarks,',
    'no people, no faces, no gore.',
  ].join(' ');
}

// Duotone via luminance then a two-stop transfer table. The split between the
// black field and the colour field is a hard vertical edge; the organic shapes
// live inside the colour field, not on its boundary. Grain is one overlay pass
// across the whole canvas — in `overlay` mode it leaves pure black untouched and
// bites only on the colour field and the photograph, which is what the printed
// reference does. All native SVG filters, so no image library is involved.
export function leadArtwork(art) {
  return `<img class="art" src="${escape(art.href)}" width="${ART_WIDTH}" height="${ART_HEIGHT}" alt="${escape(art.label)}">`;
}

// --- render ---------------------------------------------------------------

export const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

export function render(headlines, at, art, footer) {
  const dateline = at.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: TIMEZONE,
  });
  const time = at.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: TIMEZONE,
  });

  const story = ({ title, source, url }, extra = '') => {
    const heading = url
      ? `<a href="${escape(url)}" rel="noopener">${escape(title)}</a>`
      : escape(title);
    const byline = source ? `\n        <p class="meta source">${escape(source)}</p>` : '';
    return `      <article class="story${extra}">\n        <h2>${heading}</h2>${byline}\n      </article>`;
  };

  const [top, ...rest] = headlines;

  // Crawlers fetch og:image as a flat file, so it points at the baked JPEG and
  // carries the same ?v= as the page to bust their caches on each rebuild.
  const version = art?.href?.includes('?') ? art.href.slice(art.href.indexOf('?')) : '';
  const card = [
    ['og:type', 'website'],
    ['og:site_name', 'Latest News'],
    ['og:url', `${SITE}/`],
    ['og:title', CARD_TITLE],
    ['og:description', ABOUT],
    ...(art
      ? [
          ['og:image', `${SITE}/lead.jpg${version}`],
          ['og:image:width', String(ART_WIDTH)],
          ['og:image:height', String(ART_HEIGHT)],
          ['og:image:alt', art.label],
        ]
      : []),
  ];
  const named = [
    ['description', ABOUT],
    ['twitter:card', art ? 'summary_large_image' : 'summary'],
    ['twitter:title', CARD_TITLE],
    ['twitter:description', ABOUT],
    ['twitter:creator', AUTHOR.handle],
    ...(art ? [['twitter:image', `${SITE}/lead.jpg${version}`], ['twitter:image:alt', art.label]] : []),
  ];
  const social = [
    `<link rel="canonical" href="${SITE}/">`,
    ...named.map(([k, v]) => `<meta name="${k}" content="${escape(v)}">`),
    ...card.map(([k, v]) => `<meta property="${k}" content="${escape(v)}">`),
  ].join('\n');

  const banner = art ? `      <figure class="banner">\n        ${leadArtwork(art)}\n      </figure>` : '';
  const leadStory = story(top, ' story--lead');
  const stories = rest.map((h) => story(h)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Latest News</title>
${social}
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

  /* min-width:0 is the standard guard for a flex item holding a
     replaced element with an intrinsic aspect ratio. */
  main { width: 100%; max-width: 38rem; min-width: 0; }

  .meta {
    margin: 0;
    text-align: center;
    font-family: ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }



  .banner { margin: 0 0 clamp(1.4rem, 3.5vw, 2rem); }
  .banner .art { display: block; width: 100%; max-width: 100%; height: auto; }


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

  .story--lead { padding-top: 0; padding-bottom: clamp(1.9rem, 4.5vw, 2.7rem); }
  .story--lead h2 {
    font-size: clamp(1.65rem, 4.6vw, 2.35rem);
    font-weight: 600;
    line-height: 1.2;
  }

  .source { margin: 0.7rem 0 0; font-size: 0.66rem; }

  footer {
    margin-top: clamp(2.5rem, 7vw, 4rem);
    font-size: 0.62rem;
  }
  footer p { margin: 0; }
  footer .meta + .meta { margin-top: 0.5rem; }
  footer .about { margin-top: 1.2rem; }

  .about {
    margin-left: auto;
    margin-right: auto;
    max-width: 34rem;
    font-family: ui-sans-serif, -apple-system, "Helvetica Neue", Arial, sans-serif;
    font-size: 0.74rem;
    line-height: 1.55;
    letter-spacing: 0;
    text-transform: none;
    text-align: center;
    color: #767676;
  }
  .about a {
    color: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.15em;
  }
  .about a:hover { color: #000; }
  .about a:focus-visible { outline: 2px solid #767676; outline-offset: 3px; }

  /* Desktop: artwork takes the larger left column, headlines sit beside it.
     Below this width everything stacks and stays centred. */
  @media (min-width: 62rem) {
    main { max-width: 70rem; }

    .page {
      display: grid;
      grid-template-columns: 1.15fr 1fr;
      gap: clamp(2.5rem, 4vw, 4rem);
      /* Tops flush: the text column is taller, so centring left the
         artwork floating oddly low against the lead headline. */
      align-items: start;
    }

    .banner { margin: 0; }

    .column .story, .column .meta { text-align: left; }
    .story { padding: clamp(1.1rem, 2vw, 1.5rem) 0; }
    .story h2 { font-size: clamp(1.15rem, 1.6vw, 1.4rem); }

    .story--lead { padding-top: 0; padding-bottom: clamp(1.4rem, 2.4vw, 2rem); }
    .story--lead h2 { font-size: clamp(1.6rem, 2.9vw, 2.3rem); }
  }
</style>
</head>
<body>
  <main>
    <div class="page">
${banner}
      <div class="column">
${leadStory}

${stories}
      </div>
    </div>

    <footer>
      <p class="meta">${escape(dateline)} &middot; ${escape(time)}</p>
      <p class="meta">${escape(footer)}</p>
      <p class="about">${escape(ABOUT)} Made by <a href="${escape(AUTHOR.url)}" rel="noopener">${escape(AUTHOR.handle)}</a></p>
    </footer>
  </main>
</body>
</html>
`;
}
