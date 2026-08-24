# news

A single static page of current headlines, gathered by a web-search-capable
model, plus one conceptual illustration for the lead story.
Black on white, centered, no rules or masthead.

## Use

```sh
node build.mjs   # rewrites index.html (and lead.png)
open index.html
```

Keys go in `.env` (gitignored):

```sh
GEMINI_API_KEY=...   # default provider, also generates the lead image
GROQ_API_KEY=...     # only needed for NEWS_PROVIDER=groq
```

## Knobs

| Env | Default | Notes |
| --- | --- | --- |
| `NEWS_PROVIDER` | `google` | or `groq` |
| `GOOGLE_MODEL` | `gemini-3.6-flash` | search attached via the `googleSearch` tool |
| `IMAGE_MODEL` | `gemini-3.1-flash-image` | lead illustration |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | search attached via `browser_search` |
| `NEWS_COUNT` | `5` | headlines to request |
| `MAX_BACKOFF_S` | `60` | fail rather than sleep longer than this on a 429 |

Setting `GROQ_MODEL` to `groq/compound` or `groq/compound-mini` also works —
those wrap the model with search already built in, so `build.mjs` drops the
`tools` parameter for them.

## Scheduling

A launchd agent rebuilds the page every 2 hours:

```sh
launchctl list | grep com.michaljach.news       # status
tail -f build.log                               # output
launchctl unload ~/Library/LaunchAgents/com.michaljach.news.plist   # stop
```

It runs on load and every 7200s after. The node path is baked into the plist,
so regenerate it after an nvm version bump.

## Rate limits

Both providers meter the search-grounded path separately from plain generation,
and it is the grounded path this depends on.

- **Google free tier**: plain `generateContent` returns 200, while
  `googleSearch` grounding and image generation both return 429. Those two
  quotas appear to need billing enabled.
- **Groq free tier**: 200,000 tokens/day on `openai/gpt-oss-120b`. Twelve pulls
  a day fits comfortably; full `groq/compound` fans out enough to return
  `413 Request Entity Too Large` before search even runs.

`build.mjs` honours the retry hint on a 429, but fails fast rather than sleeping
past `MAX_BACKOFF_S` or on a daily cap, so a scheduled run never hangs.

## Links

The model is told to copy article URLs verbatim from search results. A URL is
kept as a link when the provider's own tool output vouches for it, or when the
page actually resolves; 404 and 410 downgrade it to plain text. Google's
grounding returns redirect URIs rather than article URLs, so there the check
falls back to the publications Google actually consulted.

## The lead image

One image per pull, for the top story only. The prompt asks for a flat, muted
editorial metaphor and explicitly rules out photorealism, real faces and text —
a photorealistic rendering of a real current event would be a fabricated news
photo. If generation fails, the page builds without it.
