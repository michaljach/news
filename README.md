# news

A single static page of current headlines, gathered by Groq's compound
web-search model from the prompt `latest news`.

## Use

```sh
export GROQ_API_KEY=...   # or drop it in .env
node build.mjs            # rewrites index.html
open index.html
```

## Knobs

| Env | Default | Notes |
| --- | --- | --- |
| `GROQ_MODEL` | `groq/compound-mini` | `groq/compound` needs a paid tier — see below |
| `NEWS_COUNT` | `12` | headlines to request |

## Free-tier limits

The free tier caps the underlying `openai/gpt-oss-120b` at 8000 tokens/minute.
Full `groq/compound` fans out to several searches per turn and exceeds that
before search even runs, returning `413 Request Entity Too Large`.
`compound-mini` makes a single tool call and fits, though it still hits 429
occasionally — `build.mjs` backs off and retries using Groq's own retry hint.

## Links

The model is told to copy URLs verbatim from search results. Each URL is then
checked against the ones that actually appear in the response's `executed_tools`
before it becomes a link; unverified ones render as plain text rather than risk
sending you to a hallucinated URL.
