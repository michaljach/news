# news

A single static page of the day's five biggest stories. The most important one
leads, set larger under a wide duotone banner made for that story alone; the
other four follow at normal weight. Black on white, centered, no rules or
masthead.

Live at **https://news.jach.me** (also on https://news.jach.workers.dev)

## Deployment

It runs as a Cloudflare Worker on the free plan, with no external API keys.

```sh
npx wrangler deploy                  # ship
npx wrangler tail                    # live logs
curl "https://news.jach.me/__build?token=$BUILD_TOKEN"   # rebuild now
```

A Cron Trigger fires every two hours. The `scheduled` handler does the whole
build — feeds, ranking, concept, image — and writes the finished page to KV. The
`fetch` handler only reads that string back, which keeps it far inside the free
plan's per-request CPU budget; building inside a request would not fit.

| Piece | Binding | Free allowance |
| --- | --- | --- |
| Page + banner storage | `NEWS` (KV) | 100k reads, 1k writes/day |
| Concept text model | `AI` — `llama-3.3-70b-instruct-fp8-fast` | 10k neurons/day |
| Banner image | `AI` — `flux-1-schnell` | ~230 images/day |

Twelve builds a day sits far under all three. `BUILD_TOKEN` is a Worker secret;
`/__build` returns 404 unless it matches.

`news.jach.me` is a custom domain on the `jach.me` zone; wrangler manages its DNS
record and certificate. Note that declaring any route turns the `*.workers.dev`
URL off unless `workers_dev` is set explicitly, which is why it is pinned to
`true` in the config.

## Tests

```sh
npm test
```

Covers the ranking contract: strict importance order, the per-outlet cap, and
that stories persist across pulls without duplicating. The order test exists
because the cap defers a story to a relaxed second pass, where it could land
below a story it outranks -- which only shows up on a day one outlet dominates.

## Local preview

```sh
node build.mjs   # rewrites index.html and lead.jpg
open index.html
```

`src/news.js` holds everything both targets share — feeds, parsing, ranking,
the artwork SVG and the page template — so local output matches production.
Only the providers differ: locally the concept comes from Groq (falling back to
the motif table) and the image from Pollinations, since Workers AI is not
reachable from outside the Worker. No key is required either way.

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

## The banner

One artwork per pull, based solely on the top-ranked story: a single red duotone
photograph with heavy film grain, 4:3. On desktop it takes the wider left column
with the headlines beside it; below 62rem it stacks above them.

It is built in two stages, because a diffusion model will not reliably honour a
compositional brief — asking one for the whole layout returned a soft blob with
none of the intended structure.

1. **Concept.** A short model call turns the lead headline into a photographable
   metaphor: "children make up half of mpox cases" becomes a blister pack with
   one capsule missing. If no model is reachable, a keyword motif table supplies
   one instead, so the artwork still relates to the story.
2. **Subject photo.** The image model renders only that object — single subject,
   plain background, hard side lighting.
3. **Treatment.** The red duotone mapping, film grain and 4:3 centre crop are
   baked into the pixels before the image is stored, so `/lead.jpg` *is* the
   finished artwork rather than a raw photo the page decorates.

Treating a symbolic object as a silkscreen is what keeps this editorial artwork
rather than a fabricated news photo. The prompt rules out real people, faces,
text and gore. If generation fails, the page still builds without it.

In production both stages run on Workers AI. Locally they fall back to Groq and
Pollinations, so the preview never needs a key.

## Social cards

Open Graph and Twitter tags are emitted per build: a fixed title, the one-line
note as the description, and `/lead.jpg` as the card image, carrying the same
`?v=` as the page so crawler caches turn over on each rebuild.

The title is deliberately static rather than the lead headline, so a shared link
does not read as an endorsement of whichever story happened to lead when the
card was scraped.

The treatment has to be baked rather than left to SVG filters for exactly this
reason — a crawler fetches `og:image` as a flat file and will not run filters, so
the stored JPEG has to already be red and grainy. That is also why the page now
uses a plain `<img>`: page and card are the same file.

## Knobs

| Env | Default | Notes |
| --- | --- | --- |
| `NEWS_COUNT` | `5` | headlines to show |
| `FEED_TIMEOUT_MS` | `20000` | per feed; a dead feed is skipped, not fatal |
| `IMAGE_TIMEOUT_MS` | `180000` | Pollinations can be slow |

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
