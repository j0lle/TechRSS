Made an English version with codex. Added openai.
Thank you Dayuan Jiang for making this!

Original README:

# TechRSS

AI-curated daily tech digest from 94 independent blogs, scored and summarized in English.

**Live site**: https://dayuanjiang.github.io/TechRSS/

## How it works

1. **Fetch** - Pulls RSS feeds from 94 independent tech blogs and merges recent Hacker News items
2. **Score** - Each article is scored by AI on three dimensions: depth, novelty, and breadth (1-10)
3. **Summarize** - Top articles get an English digest title and summary
4. **Publish** - Static site rebuilt and deployed to GitHub Pages

Runs incrementally every 30 minutes via GitHub Actions. Only new articles trigger AI calls.

## Tech stack

- [Astro](https://astro.build/) + Tailwind CSS
- [Vercel AI SDK](https://sdk.vercel.ai/) + pluggable providers (Bedrock/OpenAI)
- TypeScript

## Development

```bash
npm install
npm run dev        # Dev server
npm run digest     # Run the digest pipeline (requires provider credentials)
npm run build      # Build static site
```

## AI Provider Config

The digest pipeline supports multiple providers via environment variables:

- `AI_PROVIDER=auto` (recommended default)
- `AI_PROVIDER=bedrock`
- `AI_PROVIDER=openai`
- `AI_MODEL=<model-id>` to override model for either provider

With `AI_PROVIDER=auto`, the pipeline picks `openai` when `OPENAI_API_KEY` exists; otherwise it falls back to `bedrock`.

### Bedrock

```bash
AI_PROVIDER=bedrock
AWS_BEARER_TOKEN_BEDROCK=...
BEDROCK_REGION=us-east-1
BEDROCK_MODEL_ID=zai.glm-4.7
```

### OpenAI (or OpenAI-compatible APIs)

```bash
AI_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4.1-mini
# Optional, for OpenAI-compatible endpoints:
# OPENAI_BASE_URL=https://your-endpoint/v1
```
