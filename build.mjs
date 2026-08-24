#!/usr/bin/env node
// Local preview. Builds the same page as the deployed Worker and writes it to
// disk, so the design can be iterated on without a deploy.
//
// Production runs on Cloudflare (src/worker.js) on a two-hour cron. The shared
// logic lives in src/news.js; only the image and concept providers differ, since
// Workers AI is not reachable from here.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchFeeds,
  selectTopStories,
  conceptPrompt,
  cleanConcept,
  fallbackConcept,
  imagePrompt,
  render,
  treat,
  UA,
} from './src/news.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const IMAGE_FILE = 'lead.jpg';
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS ?? 180_000);

function readKey(name) {
  if (process.env[name]) return process.env[name];
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1 || line.trimStart().startsWith('#')) continue;
    if (line.slice(0, eq).trim() !== name) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value) return value;
  }
  return null;
}

// Groq locally, Workers AI in production. Both fall back to the motif table.
async function conceptFor(headline) {
  const key = readKey('GROQ_API_KEY');
  if (!key) return fallbackConcept(headline);
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        temperature: 0.8,
        max_tokens: 700,
        reasoning_effort: 'low',
        messages: [{ role: 'user', content: conceptPrompt(headline) }],
      }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const choice = (await res.json()).choices?.[0] ?? {};
    if (choice.finish_reason === 'length') throw new Error('concept truncated');
    const concept = cleanConcept(choice.message?.content);
    if (!concept) throw new Error('unusable concept');
    return concept;
  } catch (err) {
    console.error(`Concept step failed (${err.message}) — using motif table.`);
    return fallbackConcept(headline);
  }
}

// Pollinations needs no key, which keeps local preview working unconfigured.
async function generateLeadImage(headline) {
  const concept = await conceptFor(headline);
  const slot = Math.floor(Date.now() / 7_200_000);
  console.log(`lead concept: ${concept}`);

  try {
    const url =
      'https://image.pollinations.ai/prompt/' +
      encodeURIComponent(imagePrompt(concept)) +
      '?width=1024&height=1024&nologo=true';
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Pollinations ${res.status}`);

    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 2000) throw new Error('empty image');
    const baked = treat(bytes);
    writeFileSync(join(ROOT, IMAGE_FILE), baked);
    console.log(`lead image -> ${IMAGE_FILE} (${Math.round(baked.length / 1024)} KB)`);

    return {
      href: IMAGE_FILE,
      seed: slot % 100,
      label: `Editorial illustration: ${concept}`,
    };
  } catch (err) {
    // A missing illustration should never cost you the headlines.
    console.error(`Lead image failed (${err.message}) — building without it.`);
    return null;
  }
}

async function main() {
  const at = new Date();

  const { items, feedsUsed } = await fetchFeeds();
  if (!items.length) throw new Error('no feed returned any stories');
  console.log(`${items.length} stories from ${feedsUsed}/6 feeds`);

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
  console.error(`build failed: ${err.message}`);
  process.exit(1);
}
