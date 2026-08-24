# news

A single static page of current headlines, gathered by `openai/gpt-oss-120b`
running Groq's built-in `browser_search` tool on the prompt `latest news`,
plus one conceptual illustration for the lead story.

## Use

```sh
node build.mjs   # rewrites index.html (and lead.png)
open index.html
```

Keys go in `.env` (gitignored):

```sh
GROQ_API_KEY=...     # required
OPENAI_API_KEY=...   # optional, for the lead image
GEMINI_API_KEY=...   # optional alternative to OpenAI
```

## Knobs

| Env | Default | Notes |
| --- | --- | --- |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | search is attached as a `browser_search` tool |
| `NEWS_COUNT` | `5` | headlines to request |

Setting `GROQ_MODEL` to `groq/compound` or `groq/compound-mini` also works —
those wrap the same model with search already built in, so `build.mjs` drops the
`tools` parameter for them. Note that full `groq/compound` fans out to several
searches per turn and returns `413 Request Entity Too Large` on a free-tier key,
which caps `gpt-oss-120b` at 8000 tokens/minute. `build.mjs` backs off and
retries on 429 using Groq's own retry hint.

## Links

The model is told to copy URLs verbatim from search results. Each URL is then
checked against the ones that actually appear in the response's `executed_tools`
before it becomes a link; unverified ones render as plain text rather than risk
sending you to a hallucinated URL.

## The lead image

One image per pull, for the top story only. The prompt asks for a flat, muted
editorial metaphor and explicitly rules out photorealism, real faces and text —
a photorealistic rendering of a real current event would be a fabricated news
photo. If no image key is set, or generation fails, the page builds without it.
