#!/usr/bin/env node
// Asks Groq's compound web-search model for the "latest news" and renders
// the headlines it finds into a static index.html.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
// gpt-oss-120b driving Groq's built-in browser_search tool. The `groq/compound*`
// systems wrap the same model with search already attached, so if MODEL is set
// to one of those the tool is left off the request.
const MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
const SEARCH_IS_BUILT_IN = MODEL.startsWith('groq/compound');
const COUNT = Number(process.env.NEWS_COUNT ?? 5);
const PROMPT = 'latest news';

function apiKey() {
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY;
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) {
    const hit = readFileSync(envFile, 'utf8').match(/^\s*GROQ_API_KEY\s*=\s*(.+?)\s*$/m);
    if (hit) return hit[1].replace(/^["']|["']$/g, '');
  }
  console.error('Missing GROQ_API_KEY — put it in .env or export it, then rerun.');
  process.exit(1);
}

const SYSTEM = `You are a newswire desk. Search the web for what is happening right now and report the top ${COUNT} stories.

Reply with JSON only. No prose, no code fences:
{"headlines":[{"title":"...","source":"...","url":"..."}]}

Rules:
- title: the real headline, plain text, under 110 characters, no trailing period.
- source: the publication name, e.g. "Reuters".
- url: copied verbatim from a search result. Never invent or guess one.
- Most significant story first. One entry per story, no duplicates.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Free-tier keys sit on a low tokens-per-minute cap and a single search-heavy
// turn can eat most of it, so honour the retry hint Groq sends back.
async function ask(attempt = 1) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 3000,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: PROMPT },
      ],
      ...(SEARCH_IS_BUILT_IN ? {} : { tools: [{ type: 'browser_search' }] }),
    }),
  });

  if (res.ok) return res.json();

  const text = await res.text();

  if (res.status === 413) {
    throw new Error(
      `Groq 413: the request is too large for ${MODEL} on this plan.\n` +
        'Try GROQ_MODEL=groq/compound-mini, or lower NEWS_COUNT.'
    );
  }

  if (res.status === 429 && attempt <= 4) {
    const hinted = Number(text.match(/try again in ([\d.]+)s/)?.[1]);
    const header = Number(res.headers.get('retry-after'));
    const wait = Math.ceil((hinted || header || attempt * 8) * 1000) + 750;
    console.error(`Rate limited, retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/4)...`);
    await sleep(wait);
    return ask(attempt + 1);
  }

  throw new Error(`Groq ${res.status}: ${text.slice(0, 400)}`);
}

async function fetchHeadlines() {
  const body = await ask();
  const message = body.choices?.[0]?.message ?? {};
  const raw = (message.content ?? '').trim();
  const json = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Model did not return JSON:\n${raw.slice(0, 400)}`);
  }

  // Only link out to URLs the search tool actually returned — the model is
  // told not to invent them, but a dead link is worse than no link.
  const seen = harvestUrls(message.executed_tools);

  return (parsed.headlines ?? [])
    .filter((h) => h && typeof h.title === 'string' && h.title.trim())
    .slice(0, COUNT)
    .map((h) => ({
      title: h.title.trim().replace(/\.$/, ''),
      source: (h.source ?? '').trim(),
      url: wasSearched(h.url, seen) ? h.url : null,
    }));
}

function harvestUrls(executedTools) {
  const urls = new Set();
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const url of value.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []) urls.add(url);
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  walk(executedTools ?? []);
  return urls;
}

function wasSearched(candidate, seen) {
  if (!candidate) return false;
  const key = (u) => {
    try {
      const { host, pathname } = new URL(u);
      return `${host.replace(/^www\./, '')}${pathname.replace(/\/+$/, '')}`;
    } catch {
      return null;
    }
  };
  const want = key(candidate);
  if (!want) return false;
  for (const url of seen) if (key(url) === want) return true;
  return false;
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function render(headlines, at) {
  const dateline = at.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

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

${stories}

    <footer class="meta">Gathered by ${escape(MODEL)}</footer>
  </main>
</body>
</html>
`;
}

const at = new Date();
const headlines = await fetchHeadlines();
if (!headlines.length) throw new Error('No headlines came back.');

const out = join(ROOT, 'index.html');
writeFileSync(out, render(headlines, at));
console.log(`${headlines.length} headlines -> ${out}`);
