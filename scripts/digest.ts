import 'dotenv/config';
import { writeFile, readFile, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import TurndownService from 'turndown';
import { RSS_FEEDS } from '../src/lib/feeds';
import { fetchAllFeeds } from '../src/lib/rss';
import { processArticles, summarizeArticle } from '../src/lib/ai';
import { fetchWithPlaywright, closeBrowser } from './fetch-content';
import type { Article } from '../src/lib/types';

const DATA_DIR = path.join(process.cwd(), 'data');
const HN_FILE = path.join(DATA_DIR, 'hn.json');
const NH_API = 'https://api.newshacker.me';
const HN_LIST_SIZE = 50;
const HN_MIN_SCORE = 100;
const CONTENT_FETCH_TIMEOUT_MS = 10_000;
const CONTENT_CONCURRENCY = 10;

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

interface HnItem {
  id: number;
  by: string;
  title: string;
  url?: string;
  score: number;
  createdAt: number;
  articleSummary?: string;
  classifications?: { tags?: string[] };
  aiSummary?: { context?: string };
  aisummary?: { context?: string };
}

function getTodayDate(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

/** Load article links from recent JSON files for dedup */
async function loadRecentLinks(excludeDate: string, days: number): Promise<Set<string>> {
  const links = new Set<string>();
  if (!existsSync(DATA_DIR)) return links;

  const files = await readdir(DATA_DIR);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const date = file.replace('.json', '');
    if (date === excludeDate || date < cutoff) continue;
    const data = JSON.parse(await readFile(path.join(DATA_DIR, file), 'utf-8'));
    for (const a of data.articles || []) {
      links.add(a.link);
    }
  }
  return links;
}

/** Load today's existing data file if it exists */
async function loadTodayData(today: string): Promise<{ articles: any[] } | null> {
  const filePath = path.join(DATA_DIR, `${today}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(await readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/** Load HN items from local cache first, then API fallback. */
async function loadHnItems(): Promise<HnItem[] | null> {
  if (existsSync(HN_FILE)) {
    try {
      const cached = JSON.parse(await readFile(HN_FILE, 'utf-8')) as { items?: HnItem[] };
      if (Array.isArray(cached.items)) {
        return cached.items;
      }
    } catch {
      // Ignore invalid cache and fall through to API.
    }
  }

  try {
    const response = await fetch(`${NH_API}/list?page=1&pageSize=${HN_LIST_SIZE}&minScore=${HN_MIN_SCORE}`);
    if (!response.ok) {
      console.warn(`[digest] HN list API returned ${response.status}`);
      return null;
    }
    const data = await response.json() as { items?: HnItem[] };
    return Array.isArray(data.items) ? data.items : [];
  } catch (error) {
    console.warn(`[digest] Failed to load HN list: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function normalizeHnScore(points: number): number {
  // Log scaling keeps HN points comparable to RSS 3-metric total (~3-30).
  const scaled = Math.round(Math.log10(Math.max(1, points) + 10) * 12);
  return Math.min(30, Math.max(8, scaled));
}

function mapHnItemsToDigestRows(items: HnItem[], cutoffMs: number) {
  return items
    .filter(item => item.createdAt * 1000 > cutoffMs)
    .map(item => {
      const hnLink = `https://news.ycombinator.com/item?id=${item.id}`;
      const summary = (item.articleSummary || item.aiSummary?.context || item.aisummary?.context || '').trim();
      return {
        title: item.title,
        title_display: item.title,
        link: item.url || hnLink,
        pub_date: new Date(item.createdAt * 1000).toISOString(),
        summary,
        source_name: 'Hacker News',
        source_type: 'hn' as const,
        hn_points: item.score,
        score: normalizeHnScore(item.score),
        category: 'other',
        keywords: (item.classifications?.tags || []).slice(0, 4),
      };
    });
}

function dedupeByLink<T extends { link: string; score: number }>(articles: T[]): T[] {
  const byLink = new Map<string, T>();
  for (const article of articles) {
    const existing = byLink.get(article.link);
    if (!existing || article.score > existing.score) {
      byLink.set(article.link, article);
    }
  }
  return Array.from(byLink.values());
}

function toTimestamp(pubDate: string): number {
  const ts = Date.parse(pubDate);
  return Number.isFinite(ts) ? ts : 0;
}

/** Fetch full article content from URL, convert HTML to markdown. Falls back to Playwright. */
async function fetchArticleContent(url: string): Promise<string | null> {
  // Try plain fetch first (fast)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONTENT_FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TechDigest/1.0 (RSS Reader)' },
    });
    clearTimeout(timeout);
    if (response.ok) {
      const html = await response.text();
      const md = turndown.turndown(html);
      if (md && md.length > 200) return md;
    }
  } catch { /* fall through to Playwright */ }

  // Fallback: Playwright
  return fetchWithPlaywright(url);
}

/** Fetch full content for all articles, replacing content field. Falls back to RSS content. */
async function fetchAllContent(articles: Article[]): Promise<void> {
  console.log(`[digest] Fetching full content for ${articles.length} articles...`);
  for (let i = 0; i < articles.length; i += CONTENT_CONCURRENCY) {
    const batch = articles.slice(i, i + CONTENT_CONCURRENCY);
    await Promise.all(batch.map(async (article) => {
      const fullContent = await fetchArticleContent(article.link);
      if (fullContent) {
        article.content = fullContent;
      }
    }));
    const progress = Math.min(i + CONTENT_CONCURRENCY, articles.length);
    console.log(`[digest] Content fetch: ${progress}/${articles.length}`);
  }
}

async function main() {
  try {
  const today = getTodayDate();
  console.log(`[digest] === TechDigest — ${today} ===`);

  // Load existing today's data for incremental update
  const existingData = await loadTodayData(today);
  const existingArticles = existingData?.articles || [];
  const existingLinksToday = new Set(existingArticles.map((a: any) => a.link));
  console.log(`[digest] Existing articles today: ${existingArticles.length}`);

  // Step 1: Fetch feeds
  console.log(`[digest] Step 1/4: Fetching ${RSS_FEEDS.length} RSS feeds...`);
  const { articles: allArticles, successCount } = await fetchAllFeeds(RSS_FEEDS);

  if (allArticles.length === 0) {
    console.error('[digest] No articles fetched. Exiting.');
    process.exit(1);
  }

  // Step 2: Filter to last 24h (fallback 48h)
  console.log('[digest] Step 2/4: Filtering to last 24 hours...');
  let cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  let recent = allArticles.filter(a => a.pubDate.getTime() > cutoff.getTime());
  console.log(`[digest] ${recent.length} articles within last 24h`);

  if (recent.length === 0) {
    const cutoff48 = new Date(Date.now() - 48 * 60 * 60 * 1000);
    cutoff = cutoff48;
    recent = allArticles.filter(a => a.pubDate.getTime() > cutoff48.getTime());
    console.log(`[digest] Fallback to 48h: ${recent.length} articles`);
  }

  if (recent.length === 0) {
    console.error('[digest] No recent articles found. Exiting.');
    process.exit(1);
  }

  // Step 3: Dedup against cross-day AND today's existing articles
  console.log('[digest] Step 3/4: Dedup...');
  const existingLinks = await loadRecentLinks(today, 3);
  const deduped = recent.filter(a => !existingLinks.has(a.link) && !existingLinksToday.has(a.link));
  console.log(`[digest] ${deduped.length} new articles after dedup`);
  const hnItems = await loadHnItems();
  const hnRows = hnItems
    ? mapHnItemsToDigestRows(hnItems, cutoff.getTime())
    : existingArticles.filter((a: any) => a.source_type === 'hn');
  console.log(`[digest] HN items in window: ${hnRows.length}${hnItems === null ? ' (reused cached from digest file)' : ''}`);

  let newArticles: any[] = [];

  if (deduped.length === 0) {
    console.log('[digest] No new RSS articles. Skipping RSS AI calls.');
  } else {
    // Fetch full article content
    await fetchAllContent(deduped);

    // Step 4: AI process (score + summarize in one call)
    console.log(`[digest] Step 4/4: AI processing ${deduped.length} new articles...`);
    let results = await processArticles(deduped);

    // Retry failed articles
    const failedIndices = deduped.map((_, i) => i).filter(i => !results.has(i));
    if (failedIndices.length > 0) {
      console.log(`[digest] Retrying ${failedIndices.length} failed articles...`);
      const retryArticles = failedIndices.map(i => deduped[i]);
      const retryResults = await processArticles(retryArticles);
      retryResults.forEach((v, retryIdx) => { results.set(failedIndices[retryIdx], v); });
    }

    // Generate detailed article summaries (same as HN logic)
    const ARTICLE_CONCURRENCY = 5;
    const articleSummaries = new Map<number, string>();
    const needArticleSummary = deduped.map((a, i) => ({ article: a, index: i })).filter(({ article }) => article.content && article.content.length >= 200);
    console.log(`[digest] Generating article summaries for ${needArticleSummary.length} articles...`);
    for (let i = 0; i < needArticleSummary.length; i += ARTICLE_CONCURRENCY) {
      const batch = needArticleSummary.slice(i, i + ARTICLE_CONCURRENCY);
      await Promise.all(batch.map(async ({ article, index }) => {
        const summary = await summarizeArticle(article.title, article.content);
        if (summary) articleSummaries.set(index, summary);
      }));
      console.log(`[digest] Article summary: ${Math.min(i + ARTICLE_CONCURRENCY, needArticleSummary.length)}/${needArticleSummary.length}`);
    }

    newArticles = deduped.map((article, index) => {
      const r = results.get(index);
      if (!r) return null;
      const score = r.depth + r.novelty + r.breadth;
      return {
        title: article.title,
        title_display: r.titleDisplay || article.title,
        link: article.link,
        pub_date: article.pubDate.toISOString(),
        summary: articleSummaries.get(index) || r.summary || '',
        source_name: article.sourceName,
        source_type: 'rss' as const,
        score,
        depth: r.depth,
        novelty: r.novelty,
        breadth: r.breadth,
        category: r.category,
        keywords: r.keywords,
      };
    }).filter((a): a is NonNullable<typeof a> => a !== null);
  }

  // Merge: existing + new, order by publish date (newest first), re-rank
  const existingRss = existingArticles.filter((a: any) => (a.source_type || 'rss') !== 'hn');
  const merged = dedupeByLink([...existingRss, ...newArticles, ...hnRows]);
  merged.sort((a: any, b: any) => {
    const dateDiff = toTimestamp(b.pub_date) - toTimestamp(a.pub_date);
    if (dateDiff !== 0) return dateDiff;
    return b.score - a.score;
  });
  const top = merged.slice(0, 100);
  top.forEach((a: any, i: number) => { a.rank = i + 1; });

  // Write JSON
  await mkdir(DATA_DIR, { recursive: true });
  const output = {
    date: today,
    total_feeds: RSS_FEEDS.length,
    success_feeds: successCount,
    total_articles: allArticles.length,
    filtered_articles: recent.length + hnRows.length,
    articles: top,
  };

  const outPath = path.join(DATA_DIR, `${today}.json`);
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`[digest] Written ${outPath}`);
  console.log(`[digest] Done! ${existingArticles.length} existing + ${newArticles.length} new -> ${top.length} total`);
  } finally {
    await closeBrowser();
  }
}

main().catch(err => {
  console.error(`[digest] Fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
