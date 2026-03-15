import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, Output } from 'ai';
import { z } from 'zod';
import type { Article } from './types';

type SupportedProvider = 'bedrock' | 'openai';
type ProviderSetting = SupportedProvider | 'auto';

function env(name: string): string | undefined {
  const value = process.env[name];
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasEnv(name: string): boolean {
  return Boolean(env(name));
}

function normalizeOpenAIBaseUrl(value: string | undefined): string {
  const base = value || 'https://api.openai.com/v1';
  try {
    // Validate absolute URL early so runtime errors are actionable.
    new URL(base);
    return base;
  } catch {
    throw new Error(`[ai] OPENAI_BASE_URL must be an absolute URL (for example: https://api.openai.com/v1). Received: "${base}"`);
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveProvider(): SupportedProvider {
  const configured = (env('AI_PROVIDER') || 'auto').toLowerCase() as ProviderSetting;

  if (configured === 'auto') {
    // Prefer OpenAI when its key is present; otherwise fall back to Bedrock.
    return env('OPENAI_API_KEY') ? 'openai' : 'bedrock';
  }

  if (configured === 'bedrock' || configured === 'openai') {
    return configured;
  }
  throw new Error(`[ai] Unsupported AI_PROVIDER "${configured}". Use "auto", "bedrock", or "openai".`);
}

function createModel() {
  const provider = resolveProvider();

  if (provider === 'openai') {
    const apiKey = env('OPENAI_API_KEY');
    if (!apiKey) {
      throw new Error('[ai] OPENAI_API_KEY is required when AI_PROVIDER=openai.');
    }
    const baseURL = normalizeOpenAIBaseUrl(env('OPENAI_BASE_URL'));
    const openai = createOpenAI({
      apiKey,
      baseURL,
      organization: env('OPENAI_ORG'),
      project: env('OPENAI_PROJECT'),
    });
    const modelId = env('AI_MODEL') || env('OPENAI_MODEL') || 'gpt-4.1-mini';
    return {
      model: openai(modelId),
      provider,
      modelId,
    };
  }

  const hasLikelyBedrockAuth = hasEnv('AWS_BEARER_TOKEN_BEDROCK')
    || hasEnv('AWS_ACCESS_KEY_ID')
    || hasEnv('AWS_PROFILE')
    || hasEnv('AWS_WEB_IDENTITY_TOKEN_FILE');
  if (!hasLikelyBedrockAuth) {
    console.warn('[ai] Using Bedrock but no obvious AWS auth env vars were found. If you intended OpenAI, set AI_PROVIDER=openai and OPENAI_API_KEY.');
  }

  const bedrock = createAmazonBedrock({
    region: env('BEDROCK_REGION') || env('AWS_REGION') || 'us-east-1',
  });
  const modelId = env('AI_MODEL') || env('BEDROCK_MODEL_ID') || 'zai.glm-4.7';
  return {
    model: bedrock(modelId),
    provider,
    modelId,
  };
}

const { model: aiModel, provider: aiProvider, modelId } = createModel();
const MAX_CONCURRENT = parsePositiveInt(env('AI_MAX_CONCURRENT'), 10);

console.log(`[ai] Provider=${aiProvider} Model=${modelId} Concurrency=${MAX_CONCURRENT}`);

const articleResultSchema = z.object({
  depth: z.number(),
  novelty: z.number(),
  breadth: z.number(),
  category: z.string(),
  keywords: z.array(z.string()),
  titleDisplay: z.string(),
  summary: z.string(),
});

export type ArticleResult = z.infer<typeof articleResultSchema>;

function buildPrompt(article: { title: string; content: string; sourceName: string; link: string }): string {
  const articleText = `[${article.sourceName}] ${article.title}\nURL: ${article.link}\n${article.content}`;

  return `You are a technical content curator preparing a daily digest for AI and software engineers. Most sources are independent technical blogs about AI/LLMs, security, and systems engineering.

Evaluate the article with strict score separation. Return three integer scores (1-10), one main category, 2-4 keywords, an English digest title, and an English summary.

---

# Part 1: Scoring

## Scoring discipline
- Use extreme scores when deserved: low-signal updates can be 1-3, deep original work can be 8-10.
- Do not reward hype. Judge evidence and technical value.

## Dimensions

### 1. depth
How strong is the technical evidence and implementation detail?

High-score signals:
- AI: eval data (MMLU, HumanEval, SWE-bench, etc.), training details, latency/cost data, ablations, production lessons
- Engineering: benchmarks, profiling, architecture details, migration/postmortem details
- Security: PoC, exploit chain, impact analysis

Low-score signals:
- PR language ("Introducing...", "We're excited...")
- Generic hot takes with no supporting evidence
- News rewrites or roundups without first-hand insight

Guide: 8-10 strong first-hand evidence | 5-7 good technical detail but limited evidence | 3-4 accurate but shallow | 1-2 announcement/rehash

### 2. novelty
How original is the information or viewpoint?

High-score signals:
- First deep review of a new model/system
- Evidence-backed challenge to mainstream assumptions
- Newly disclosed vulnerability or underreported technical approach
- First-hand production experience with concrete findings

Low-score signals:
- Another generic tutorial/wrapper post
- Follow-up echo of already saturated news
- Repeating known ideas without incremental insight

Guide: 8-10 original disclosure/research/angle | 5-7 partially new angle | 3-4 mostly repetitive | 1-2 pure retelling

### 3. breadth
How many technical practitioners can benefit?

High-score signals:
- Major model/platform releases with broad impact
- Cross-language or cross-framework security/engineering implications
- Structural changes to software development practice

Low-score signals:
- Niche tweak for one model or niche framework
- Personal diary-style post with limited transferability

Guide: 8-10 broad industry relevance | 5-7 useful across multiple domains | 3-4 narrow audience | 1-2 very niche

## Category (choose one)
- ai-ml
- security
- engineering
- tools
- opinion
- other

When multiple themes appear, choose the dominant one by article weight.

## Calibration examples
| Article type | depth | novelty | breadth | Why |
|---|---:|---:|---:|---|
| New model deep benchmark with cost/perf comparisons | 9 | 9 | 9 | First-hand data + strong impact |
| Production coding-agent retrospective with real metrics | 8 | 7 | 8 | Practical first-hand insight |
| Generic "build a RAG pipeline" tutorial | 4 | 2 | 4 | Useful but saturated |
| "AI will replace all programmers" opinion piece | 2 | 2 | 6 | Broad topic, weak evidence |
| Deep scaling-law critique with experiments | 8 | 9 | 8 | Contrarian and evidence-backed |
| Narrow fine-tuning parameter tuning note | 7 | 5 | 3 | Technically deep but niche |
| First public critical CVE disclosure with PoC | 8 | 10 | 10 | Original and urgent |
| Personal weekly diary | 2 | 2 | 2 | Low transferability |
| Migration postmortem with production metrics | 9 | 8 | 7 | Rare operational evidence |
| "X released v2.0" brief | 2 | 5 | 6 | Announcement, little analysis |

## Keywords
Return 2-4 English keywords. Keep proper nouns as-is; use lowercase for generic terms.

---

# Part 2: English title and summary

## Digest title (titleDisplay)
Write a concise English title that captures the key information.

Requirements:
- Max 12 words
- Focus on one core point
- Preserve technical names (Rust, RAG, Claude, etc.)
- Do not mechanically rewrite the original headline

## Summary (summary)
Give readers enough information without opening the source.

Length rules based on average score = (depth + novelty + breadth) / 3:
- average >= 6: 180-260 words
- average > 3 and < 6: 40-80 words
- average <= 3: empty string

Writing rules:
- Open with the key fact or conclusion immediately
- Include concrete evidence: metrics, versions, model names, benchmark names
- Explain practical significance in the final sentence
- Avoid vague phrasing like "significantly improved" without numbers

---

# Article to process

${articleText}`;
}

export async function summarizeArticle(title: string, content: string): Promise<string | null> {
  const MAX_CONTENT_CHARS = 15_000;
  const truncated = content.length > MAX_CONTENT_CHARS
    ? content.slice(0, MAX_CONTENT_CHARS) + '\n\n[...truncated]'
    : content;
  try {
    const { text } = await generateText({
      model: aiModel,
      prompt: `You are a technical writer for experienced software engineers.

Write an English long-form summary that explains the article as a coherent story, not a bullet dump.

# Style
- Write like a strong engineering blog post, not a formal report.
- Keep technical precision while staying readable.
- Preserve key details: metrics, versions, model names, benchmarks, architecture choices.
- Explain reasoning, trade-offs, and why decisions were made.

# Output format
## One-sentence takeaway
One sentence capturing the core point.

## Body
- 4-8 sections with informative level-3 headings (###).
- Keep clear narrative flow: problem -> attempt -> findings -> approach -> outcome.
- Short to medium sentences. Split overly long sentences.

# Constraints
1. Stay faithful to the source, no invented claims.
2. Keep terminology accurate.
3. Write in English.

# Article
Title: ${title}

${truncated}`,
      maxOutputTokens: 4096,
      temperature: 0.3,
    });
    return text?.trim() || null;
  } catch (e) {
    console.warn(`[ai] summarizeArticle failed "${title}": ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function processArticles(articles: Article[]): Promise<Map<number, ArticleResult>> {
  const allResults = new Map<number, ArticleResult>();

  console.log(`[ai] Processing ${articles.length} articles (1 per call, concurrency ${MAX_CONCURRENT})`);
  const validCategories = new Set(['ai-ml', 'security', 'engineering', 'tools', 'opinion', 'other']);
  const clamp = (v: number) => Math.min(10, Math.max(1, Math.round(v)));

  for (let i = 0; i < articles.length; i += MAX_CONCURRENT) {
    const group = articles.slice(i, i + MAX_CONCURRENT);
    await Promise.all(group.map(async (article, j) => {
      const index = i + j;
      try {
        const { output } = await generateText({
          model: aiModel,
          output: Output.object({ schema: articleResultSchema }),
          prompt: buildPrompt({ title: article.title, content: article.content, sourceName: article.sourceName, link: article.link }),
          maxOutputTokens: 4096,
          temperature: 0.3,
        });
        if (output) {
          allResults.set(index, {
            ...output,
            depth: clamp(output.depth),
            novelty: clamp(output.novelty),
            breadth: clamp(output.breadth),
            category: validCategories.has(output.category) ? output.category : 'other',
            keywords: output.keywords.slice(0, 4),
          });
        }
      } catch (error) {
        console.warn(`[ai] Failed article ${index} "${article.title}": ${error instanceof Error ? error.message : error}`);
      }
    }));
    console.log(`[ai] Progress: ${Math.min(i + MAX_CONCURRENT, articles.length)}/${articles.length}`);
  }

  return allResults;
}
