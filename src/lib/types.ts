export type CategoryId = 'ai-ml' | 'security' | 'engineering' | 'tools' | 'opinion' | 'other';

export const CATEGORY_META: Record<CategoryId, { emoji: string; label: string }> = {
  'ai-ml': { emoji: '🤖', label: 'AI / ML' },
  'security': { emoji: '🔒', label: 'Security' },
  'engineering': { emoji: '⚙️', label: 'Engineering' },
  'tools': { emoji: '🛠', label: 'Tools / OSS' },
  'opinion': { emoji: '💡', label: 'Opinion' },
  'other': { emoji: '📝', label: 'Other' },
};

export interface Article {
  title: string;
  link: string;
  pubDate: Date;
  content: string;
  sourceName: string;
  sourceUrl: string;
}

export interface ArticleRow {
  title: string;
  title_display?: string;
  title_zh?: string;
  link: string;
  pub_date: string;
  summary: string;
  source_name: string;
  source_type?: 'rss' | 'hn';
  hn_points?: number;
  score: number;
  depth?: number;
  novelty?: number;
  breadth?: number;
  category: string;
  keywords: string[];
  rank: number;
}
