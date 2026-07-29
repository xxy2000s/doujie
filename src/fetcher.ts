import * as cheerio from 'cheerio';
import type { SourceInput } from './types.js';

const URL_REGEX = /https?:\/\/[^\s<>]+/g;
const TRAILING_URL_PUNCTUATION = /[.,!?;:，。！？；：、]+$/;

export type FetchedUrl = SourceInput & {
  content: string;
};

export type ReadableArticle = {
  title: string | null;
  text: string;
};

type HtmlExtractor = {
  name: string;
  matches(url: string): boolean;
  extract($: cheerio.CheerioAPI, url: string): ReadableArticle | null;
};

const READABLE_CONTAINER_SELECTORS = [
  'article',
  '.article-content',
  '.post-content',
  '.entry-content',
  '[role="main"]',
  'main',
];

const HTML_EXTRACTORS: HtmlExtractor[] = [
  {
    name: 'wechat',
    matches: (url) => url.includes('mp.weixin.qq.com'),
    extract: extractWeChatArticle,
  },
  {
    name: 'semantic-container',
    matches: () => true,
    extract: extractSemanticContainerArticle,
  },
  {
    name: 'body-fallback',
    matches: () => true,
    extract: extractBodyFallbackArticle,
  },
];

function stripTrailingUrlPunctuation(url: string): string {
  let cleaned = url.trim();
  while (TRAILING_URL_PUNCTUATION.test(cleaned)) {
    cleaned = cleaned.replace(TRAILING_URL_PUNCTUATION, '');
  }
  return cleaned;
}

export function normalizeUrl(rawUrl: string): string | null {
  const cleaned = stripTrailingUrlPunctuation(rawUrl);
  try {
    const url = new URL(cleaned);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Extract URLs from message text */
export function extractUrls(text: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const match of text.match(URL_REGEX) || []) {
    const normalized = normalizeUrl(match);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  return urls;
}

/** Fetch a URL and extract readable text content */
export async function fetchArticleContent(url: string): Promise<string> {
  const result = await fetchUrlDetails(url);
  if (result.fetchStatus === 'failed') {
    throw new Error(result.error ?? `Failed to fetch ${url}`);
  }
  return result.content;
}

async function fetchUrlDetails(url: string): Promise<FetchedUrl> {
  const canonicalUrl = normalizeUrl(url) ?? url;
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }

  const html = await response.text();
  const finalUrl = normalizeUrl(response.url || url) ?? canonicalUrl;
  const article = extractReadableArticle(html, finalUrl);
  return {
    originalUrl: url,
    canonicalUrl: finalUrl,
    finalUrl,
    domain: getDomain(finalUrl),
    title: article.title,
    fetchStatus: 'fetched',
    contentLength: article.text.length,
    error: null,
    content: article.text,
  };
}

/** Extract readable text from HTML through the ordered extractor pipeline. */
export function extractReadableArticle(html: string, url: string): ReadableArticle {
  const $ = cheerio.load(html);

  for (const extractor of HTML_EXTRACTORS) {
    if (extractor.matches(url)) {
      const article = extractor.extract($, url);
      if (article && article.text.trim()) {
        return article;
      }
    }
  }

  return { title: getHtmlTitle($), text: '' };
}

function extractWeChatArticle($: cheerio.CheerioAPI, _url: string): ReadableArticle | null {
  const title = ($('meta[property="og:title"]').attr('content')
    || $('meta[property="twitter:title"]').attr('content')
    || $('var[msg_title]').text()
    || '').trim() || null;
  const text = cleanSelectedText($, '#js_content', '.qr_code_pc, #js_pc_qr_code');
  if (!text) return null;
  return { title, text: title ? `标题: ${title}\n\n${text}` : text };
}

function extractSemanticContainerArticle($: cheerio.CheerioAPI, _url: string): ReadableArticle | null {
  for (const selector of READABLE_CONTAINER_SELECTORS) {
    const text = cleanSelectedText($, selector);
    if (text.length > 100) {
      const title = getHtmlTitle($);
      return { title, text: title ? `标题: ${title}\n\n${text}` : text };
    }
  }
  return null;
}

function extractBodyFallbackArticle($: cheerio.CheerioAPI, _url: string): ReadableArticle {
  const text = cleanSelectedText($, 'body').slice(0, 10000);
  const title = getHtmlTitle($);
  return { title, text: title ? `标题: ${title}\n\n${text}` : text };
}

function cleanSelectedText($: cheerio.CheerioAPI, selector: string, extraRemoveSelector = ''): string {
  const el = $(selector).first();
  if (!el.length) return '';
  const clone = el.clone();
  const removeSelector = [
    'script',
    'style',
    'nav',
    'header',
    'footer',
    '.ad',
    '.sidebar',
    extraRemoveSelector,
  ].filter(Boolean).join(', ');
  clone.find(removeSelector).remove();
  return clone.text().replace(/\s+/g, ' ').trim();
}

function getHtmlTitle($: cheerio.CheerioAPI): string | null {
  return ($('title').text().trim() || $('h1').first().text().trim() || '').trim() || null;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function errorDetail(err: unknown): string {
  const error = err as Error & { cause?: { message?: string; code?: string } };
  return error.cause?.message || error.cause?.code || error.message || 'unknown error';
}

function failedUrl(url: string, detail: string): FetchedUrl {
  const canonicalUrl = normalizeUrl(url) ?? url;
  return {
    originalUrl: url,
    canonicalUrl,
    finalUrl: null,
    domain: getDomain(canonicalUrl),
    title: null,
    fetchStatus: 'failed',
    contentLength: 0,
    error: detail,
    content: `(抓取失败: ${detail})`,
  };
}

export async function fetchAllUrlDetails(urls: string[]): Promise<FetchedUrl[]> {
  const results: FetchedUrl[] = [];

  for (const url of urls.slice(0, 3)) {
    // max 3 URLs per message
    try {
      console.log(`[fetcher] Fetching: ${url}`);
      results.push(await fetchUrlDetails(url));
    } catch (err) {
      const detail = errorDetail(err);
      console.error(`[fetcher] Failed to fetch ${url}: ${detail}`);
      results.push(failedUrl(url, detail));
    }
  }

  return results;
}

export function formatFetchedUrlDetails(results: FetchedUrl[]): string {
  return results.map((result) => {
    const sourceUrl = result.finalUrl ?? result.canonicalUrl;
    return `[来源: ${sourceUrl}]\n${result.content}`;
  }).join('\n\n---\n\n');
}

/** Fetch multiple URLs and combine their content */
export async function fetchAllUrls(urls: string[]): Promise<string> {
  return formatFetchedUrlDetails(await fetchAllUrlDetails(urls));
}
