#!/usr/bin/env node
// Pulls current headlines from a web-search-capable model and renders them
// into a static index.html, plus one conceptual illustration for the lead story.
//
// Default provider is Google (Gemini + Google Search grounding), which has a
// free tier and covers both the search and the image with a single key.
// Groq is kept behind NEWS_PROVIDER=groq.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PROVIDER = process.env.NEWS_PROVIDER ?? 'google';
const COUNT = Number(process.env.NEWS_COUNT ?? 5);
const PROMPT = 'latest news';
const IMAGE_FILE = 'lead.png';

const GOOGLE_MODEL = process.env.GOOGLE_MODEL ?? 'gemini-3.6-flash';
const IMAGE_MODEL = process.env.IMAGE_MODEL ?? 'gemini-3.1-flash-image';
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';

const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 90_000);
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 120_000);
const MAX_BACKOFF_S = Number(process.env.MAX_BACKOFF_S ?? 60);

const GOOGLE_API = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readKey(...names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
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

const googleKey = () => readKey('GEMINI_API_KEY', 'GOOGLE_API_KEY');

const SYSTEM = `You are a newswire desk. Search the web for what is happening right now and report the top ${COUNT} stories.

Reply with JSON only. No prose, no code fences:
{"headlines":[{"title":"...","source":"...","url":"..."}]}

Rules:
- title: the real headline, plain text, under 110 characters, no trailing period.
- source: the publication name, e.g. "Reuters".
- url: the direct article URL, copied verbatim from a search result. Never invent one.
- Most significant story first. One entry per story, no duplicates.`;

// --- shared helpers -------------------------------------------------------

function parseHeadlines(raw) {
  const text = (raw ?? '').trim();
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`model did not return JSON: ${text.slice(0, 200)}`);
  }
  return (parsed.headlines ?? [])
    .filter((h) => h && typeof h.title === 'string' && h.title.trim())
    .slice(0, COUNT)
    .map((h) => ({
      title: h.title.trim().replace(/\.$/, ''),
      source: (h.source ?? '').trim(),
      url: typeof h.url === 'string' ? h.url.trim() : null,
    }));
}

const bareHost = (u) => {
  try {
    return new URL(u).host.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

function collectUrls(value, into = new Set()) {
  if (typeof value === 'string') {
    for (const url of value.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) into.add(url);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectUrls(v, into));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectUrls(v, into));
  }
  return into;
}

// Only 404/410 prove a URL is fabricated. News sites routinely answer bots with
// 403, so treat anything else that responds as good enough to link.
async function looksAlive(url) {
  const opts = {
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; news-page link check)' },
  };
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { ...opts, method: 'GET' });
    }
    return res.status !== 404 && res.status !== 410;
  } catch {
    return false;
  }
}

// A link is kept when the provider's own tool output vouches for it, otherwise
// when the page actually resolves. Everything else renders as plain text.
async function verifyLinks(headlines, { urls = new Set(), hosts = new Set() }) {
  const exact = new Set();
  for (const u of urls) {
    const host = bareHost(u);
    if (!host) continue;
    exact.add(`${host}${new URL(u).pathname.replace(/\/+$/, '')}`);
  }

  return Promise.all(
    headlines.map(async (h) => {
      if (!h.url) return { ...h, url: null };
      const host = bareHost(h.url);
      if (!host) return { ...h, url: null };

      let path;
      try {
        path = `${host}${new URL(h.url).pathname.replace(/\/+$/, '')}`;
      } catch {
        return { ...h, url: null };
      }

      const vouched = exact.has(path) || hosts.has(host);
      if (vouched && (await looksAlive(h.url))) return h;
      if (!vouched && (await looksAlive(h.url))) return h;
      return { ...h, url: null };
    })
  );
}

// --- google ---------------------------------------------------------------

async function fetchFromGoogle() {
  const key = googleKey();
  if (!key) throw new Error('missing GEMINI_API_KEY — put it in .env or export it');

  const body = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
    tools: [{ googleSearch: {} }],
    generationConfig: { temperature: 0.2 },
  };

  const data = await googleCall(`${GOOGLE_MODEL}:generateContent`, key, body, TIMEOUT_MS);
  const candidate = data.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? '').join('');

  // Grounding gives redirect URIs rather than article URLs, so the useful
  // signal is which publications Google actually consulted.
  const hosts = new Set();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    for (const v of [chunk.web?.domain, chunk.web?.title]) {
      const h = v && String(v).toLowerCase().replace(/^www\./, '');
      if (h && h.includes('.')) hosts.add(h);
    }
  }

  return { headlines: parseHeadlines(text), hosts, urls: new Set() };
}

async function googleCall(path, key, body, timeout, attempt = 1) {
  let res;
  try {
    res = await fetch(`${GOOGLE_API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' && attempt <= 3) {
      console.error(`Google timed out after ${timeout / 1000}s, retrying (${attempt}/3)...`);
      return googleCall(path, key, body, timeout, attempt + 1);
    }
    throw err;
  }

  if (res.ok) return res.json();

  const text = await res.text();
  if (res.status === 429) {
    const secs = retryAfterSeconds(text, res) ?? attempt * 10;
    if (secs > MAX_BACKOFF_S || attempt > 3) {
      throw new Error(`Google quota exhausted. Retry in ${formatWait(secs)}.\n${errorMessage(text)}`);
    }
    console.error(`Rate limited, retrying in ${Math.round(secs)}s (${attempt}/3)...`);
    await sleep(secs * 1000 + 750);
    return googleCall(path, key, body, timeout, attempt + 1);
  }
  throw new Error(`Google ${res.status}: ${errorMessage(text)}`);
}

// --- groq -----------------------------------------------------------------

async function fetchFromGroq(attempt = 1) {
  const key = readKey('GROQ_API_KEY');
  if (!key) throw new Error('missing GROQ_API_KEY — put it in .env or export it');

  const builtInSearch = GROQ_MODEL.startsWith('groq/compound');
  let res;
  try {
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 3000,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: PROMPT },
        ],
        ...(builtInSearch ? {} : { tools: [{ type: 'browser_search' }] }),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' && attempt <= 3) {
      console.error(`Groq timed out after ${TIMEOUT_MS / 1000}s, retrying (${attempt}/3)...`);
      return fetchFromGroq(attempt + 1);
    }
    throw err;
  }

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 413) {
      throw new Error(`Groq 413: request too large for ${GROQ_MODEL} on this plan.`);
    }
    if (res.status === 429) {
      const secs = retryAfterSeconds(text, res) ?? attempt * 8;
      const daily = /tokens per day|\(TPD\)/i.test(text);
      if (daily || secs > MAX_BACKOFF_S || attempt > 4) {
        throw new Error(
          `Groq quota exhausted (${daily ? 'daily' : 'per-minute'} limit). ` +
            `Retry in ${formatWait(secs)}.\n${errorMessage(text)}`
        );
      }
      console.error(`Rate limited, retrying in ${Math.round(secs)}s (${attempt}/4)...`);
      await sleep(secs * 1000 + 750);
      return fetchFromGroq(attempt + 1);
    }
    throw new Error(`Groq ${res.status}: ${errorMessage(text)}`);
  }

  const message = (await res.json()).choices?.[0]?.message ?? {};
  return {
    headlines: parseHeadlines(message.content),
    urls: collectUrls(message.executed_tools),
    hosts: new Set(),
  };
}

// --- rate-limit hints -----------------------------------------------------

// Phrased as "try again in 7.5s" or "try again in 12m44.208s".
function retryAfterSeconds(text, res) {
  const m = text.match(/try again in\s+(?:(\d+)h)?(?:(\d+)m)?([\d.]+)s/i);
  if (m) return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3]);
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : null;
}

function formatWait(secs) {
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m}m ${Math.round(secs % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function errorMessage(text) {
  try {
    return JSON.parse(text).error?.message ?? text.slice(0, 250);
  } catch {
    return text.slice(0, 250);
  }
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
  const key = googleKey();
  if (!key) {
    console.error('No GEMINI_API_KEY — building without the lead image.');
    return null;
  }
  try {
    const data = await googleCall(
      `${IMAGE_MODEL}:generateContent`,
      key,
      { contents: [{ role: 'user', parts: [{ text: imagePrompt(headline) }] }] },
      IMAGE_TIMEOUT_MS
    );
    const part = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data);
    if (!part) throw new Error('no image data returned');
    writeFileSync(join(ROOT, IMAGE_FILE), Buffer.from(part.inlineData.data, 'base64'));
    console.log(`lead image -> ${IMAGE_FILE}`);
    return IMAGE_FILE;
  } catch (err) {
    // A missing illustration should never cost you the headlines.
    console.error(`Lead image failed (${err.message}) — building without it.`);
    return null;
  }
}

// --- render ---------------------------------------------------------------

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

function render(headlines, at, image) {
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

    <footer class="meta">Gathered by ${escape(PROVIDER === 'google' ? GOOGLE_MODEL : GROQ_MODEL)}</footer>
  </main>
</body>
</html>
`;
}

// --- main -----------------------------------------------------------------

async function main() {
  const at = new Date();
  const fetcher = PROVIDER === 'groq' ? fetchFromGroq : fetchFromGoogle;
  const { headlines, urls, hosts } = await fetcher();
  if (!headlines.length) throw new Error('no headlines came back');

  const linked = await verifyLinks(headlines, { urls, hosts });
  const image = await generateLeadImage(linked[0].title);

  const out = join(ROOT, 'index.html');
  writeFileSync(out, render(linked, at, image));
  console.log(
    `${linked.length} headlines (${linked.filter((h) => h.url).length} linked) -> ${out}`
  );
}

try {
  await main();
} catch (err) {
  // Scheduled runs read stderr, not stack traces.
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
