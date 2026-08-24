// Cloudflare Worker: rebuilds the news page on a cron trigger and serves it.
//
// The build runs in the scheduled handler, which gets a generous CPU budget.
// The fetch handler only reads a finished string out of KV, keeping it well
// inside the free plan's per-request CPU limit.

import {
  fetchFeeds,
  selectTopStories,
  conceptPrompt,
  cleanConcept,
  fallbackConcept,
  imagePrompt,
  leadArtwork,
  render,
} from './news.js';

const PAGE_KEY = 'page:v1';
const IMAGE_KEY = 'lead:v1';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndStore(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Seeds the page right after a deploy, and gives a manual refresh. Disabled
    // unless a BUILD_TOKEN secret is configured.
    if (url.pathname === '/__build') {
      if (!env.BUILD_TOKEN || url.searchParams.get('token') !== env.BUILD_TOKEN) {
        return new Response('not found', { status: 404 });
      }
      try {
        const html = await buildAndStore(env);
        return new Response(`rebuilt, ${html.length} bytes\n`, {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      } catch (err) {
        return new Response(`build failed: ${err.message}\n`, { status: 500 });
      }
    }

    if (url.pathname === '/lead.jpg') {
      const image = await env.NEWS.get(IMAGE_KEY, 'arrayBuffer');
      if (!image) return new Response('not found', { status: 404 });
      return new Response(image, {
        headers: {
          'content-type': 'image/jpeg',
          // Versioned by ?v= on the page, so this can cache hard.
          'cache-control': 'public, max-age=86400',
        },
      });
    }

    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return new Response('not found', { status: 404 });
    }

    const html = await env.NEWS.get(PAGE_KEY);
    if (!html) {
      return new Response(WARMING, {
        status: 503,
        headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '120' },
      });
    }

    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Rebuilt every two hours, so a short edge cache costs nothing.
        'cache-control': 'public, max-age=300',
      },
    });
  },
};

async function buildAndStore(env) {
  const at = new Date();

  const { items, feedsUsed } = await fetchFeeds();
  if (!items.length) throw new Error('no feed returned any stories');

  const picks = selectTopStories(items);
  if (!picks.length) throw new Error('no stories survived filtering');

  const art = await makeArtwork(env, picks[0].title);
  const footer = `${feedsUsed} feeds · ranked by cross-outlet coverage`;
  const html = render(picks, at, art, footer);

  await env.NEWS.put(PAGE_KEY, html);
  console.log(`built ${picks.length} headlines from ${feedsUsed} feeds, ${html.length} bytes`);
  return html;
}

async function makeArtwork(env, headline) {
  const slot = Math.floor(Date.now() / 7_200_000);
  const concept = await conceptFor(env, headline);

  try {
    const out = await env.AI.run(IMAGE_MODEL, { prompt: imagePrompt(concept), steps: 4 });
    if (!out?.image) throw new Error('model returned no image');

    const binary = atob(out.image);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    await env.NEWS.put(IMAGE_KEY, bytes);

    return {
      href: `/lead.jpg?v=${slot}`,
      seed: slot % 100,
      label: `Editorial illustration: ${concept}`,
    };
  } catch (err) {
    // A missing illustration should never cost you the headlines.
    console.error(`lead artwork failed (${err.message}) — building without it`);
    return null;
  }
}

async function conceptFor(env, headline) {
  try {
    const out = await env.AI.run(TEXT_MODEL, {
      messages: [{ role: 'user', content: conceptPrompt(headline) }],
      max_tokens: 80,
      temperature: 0.8,
    });
    const concept = cleanConcept(out?.response);
    if (!concept) throw new Error('unusable concept');
    console.log(`lead concept: ${concept}`);
    return concept;
  } catch (err) {
    console.error(`concept step failed (${err.message}) — using motif table`);
    return fallbackConcept(headline);
  }
}

const WARMING = `<!doctype html>
<meta charset="utf-8">
<title>Latest News</title>
<style>body{font-family:Georgia,serif;background:#fff;color:#000;display:flex;
min-height:100svh;align-items:center;justify-content:center;margin:0}</style>
<p>Gathering the news&hellip;</p>
`;
