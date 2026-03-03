import type { Browser } from 'playwright';
import TurndownService from 'turndown';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    if (!launching) {
      launching = (async () => {
        const { chromium } = await import('playwright');
        browser = await chromium.launch();
        return browser;
      })();
    }
    browser = await launching;
  }
  return browser;
}

export async function fetchWithPlaywright(url: string): Promise<string | null> {
  try {
    const b = await getBrowser();
    const page = await b.newPage();
    try {
      await page.goto(url, { timeout: 15_000, waitUntil: 'domcontentloaded' });
      const html = await page.content();
      return turndown.turndown(html);
    } finally {
      await page.close();
    }
  } catch (e) {
    console.warn(`[fetch-content] Failed ${url}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    launching = null;
  }
}
