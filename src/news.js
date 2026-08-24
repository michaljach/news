// Shared, environment-free logic for the news page.
//
// Imported by build.mjs (local preview, writes files) and src/worker.js
// (Cloudflare, cron-driven). Nothing here touches the filesystem, process.env
// or any Node built-in, so the same code runs in both.

export const COUNT = 5;
export const FEED_TIMEOUT_MS = 20_000;
export const TIMEZONE = 'Europe/Warsaw';

export const ABOUT =
  'Every two hours this page pulls six publisher feeds, ranks the stories by how ' +
  'many independent outlets ran each one, and generates a banner for whichever leads.';


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
export function selectTopStories(items) {
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
// One red duotone. The rotation that used to live here paired a photo tone with
// the abstract colour field; that field is gone, so there is nothing to pair.
export const DUOTONE = { dark: '#8e1f2f', light: '#f4e3e2' };

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

const channel = (hex, i) => (parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255).toFixed(3);

// Duotone via luminance then a two-stop transfer table. The split between the
// black field and the colour field is a hard vertical edge; the organic shapes
// live inside the colour field, not on its boundary. Grain is one overlay pass
// across the whole canvas — in `overlay` mode it leaves pure black untouched and
// bites only on the colour field and the photograph, which is what the printed
// reference does. All native SVG filters, so no image library is involved.
export function leadArtwork(art) {
  const { seed, label } = art;
  const table = (i) => `${channel(DUOTONE.dark, i)} ${channel(DUOTONE.light, i)}`;
  return `<svg class="art" viewBox="0 0 1536 1152" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escape(label)}">
      <defs>
        <filter id="duotone" color-interpolation-filters="sRGB">
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer>
            <feFuncR type="table" tableValues="${table(0)}"/>
            <feFuncG type="table" tableValues="${table(1)}"/>
            <feFuncB type="table" tableValues="${table(2)}"/>
          </feComponentTransfer>
        </filter>
        <filter id="grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="3" stitchTiles="stitch" seed="${seed}"/>
          <feColorMatrix type="saturate" values="0"/>
        </filter>
      </defs>

      <rect width="1536" height="1152" fill="${DUOTONE.light}"/>
      <image href="${art.href}" x="0" y="0" width="1536" height="1152"
             preserveAspectRatio="xMidYMid slice" filter="url(#duotone)"/>
      <rect width="1536" height="1152" filter="url(#grain)" opacity="0.6"
            style="mix-blend-mode:overlay"/>
    </svg>`;
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
  const banner = art ? `      <figure class="banner">\n        ${leadArtwork(art)}\n      </figure>` : '';
  const leadStory = story(top, ' story--lead');
  const stories = rest.map((h) => story(h)).join('\n');

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
      <p class="about">${escape(ABOUT)}</p>
    </footer>
  </main>
</body>
</html>
`;
}
