# news

A single static page of the day's five biggest stories, plus one conceptual
illustration for the lead. Black on white, centered, no rules or masthead.

## Use

```sh
node build.mjs   # rewrites index.html and lead.jpg
open index.html
```

No API key is required. It runs on a clean machine with nothing configured.

## How it works

**Headlines come from publisher RSS feeds**, not from a model — BBC, The
Guardian, NPR, Al Jazeera, DW and Sky News. Titles, article URLs and publication
names are taken verbatim from the feed, so nothing can be fabricated and every
link points at the publisher's own page.

**Ranking is by cross-outlet corroboration.** Headlines describing the same
event are clustered by word overlap, and a cluster scores on how many
independent outlets ran it, then how prominently they placed it, then how fresh
it is. A story six outlets carry outranks one only a single paper ran. No outlet
may supply more than half the page, so one prolific feed cannot crowd out the
rest.

This replaced an LLM ranking step. Both free tiers it could use were exhausted
within a day, and corroboration turned out to be the better signal anyway — it
is what a single feed's own ordering cannot tell you.

Newsletters, opinion, sport and lifestyle are filtered out by title and URL, so
digests like "Up First" and "First Thing" never reach the page.

## The lead image

One image per pull, for the top story only. The prompt asks for a flat, muted
editorial metaphor and explicitly rules out photorealism, real faces and text —
a photorealistic rendering of a real current event would be a fabricated news
photo. If generation fails, the page still builds.

Two providers, picked automatically:

| Provider | When | Free limit |
| --- | --- | --- |
| Cloudflare Workers AI (FLUX.1 Schnell) | `CF_ACCOUNT_ID` + `CF_API_TOKEN` set | ~230 images/day |
| Pollinations | otherwise | no key, no account, slower |

## Knobs

| Env | Default | Notes |
| --- | --- | --- |
| `NEWS_COUNT` | `5` | headlines to show |
| `FEED_TIMEOUT_MS` | `20000` | per feed; a dead feed is skipped, not fatal |
| `IMAGE_TIMEOUT_MS` | `180000` | Pollinations can be slow |

## Scheduling

A launchd agent rebuilds the page every 2 hours:

```sh
launchctl list | grep com.michaljach.news       # status
tail -f build.log                               # output
launchctl unload ~/Library/LaunchAgents/com.michaljach.news.plist   # stop
```

It runs on load and every 7200s after. The node path is baked into the plist,
so regenerate it after an nvm version bump.

## Rate limits, for the record

The earlier LLM-based versions kept dying on quota, and the pattern was
consistent: every provider meters *search-grounded* generation separately from
plain generation, and grounding is the half that runs out.

- **Google AI Studio free tier**: plain `generateContent` returns 200 while
  `googleSearch` grounding and image generation both return 429. Those need
  billing.
- **Groq free tier**: 200,000 tokens/day on `openai/gpt-oss-120b`. A handful of
  search-grounded pulls exhausts it. Full `groq/compound` fans out enough to
  return `413 Request Entity Too Large` before search even runs.

RSS has no such ceiling, which is why the page now depends on it instead.
