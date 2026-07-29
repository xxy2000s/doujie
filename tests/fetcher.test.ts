import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractReadableArticle,
  extractUrls,
  formatFetchedUrlDetails,
  normalizeUrl,
  type FetchedUrl,
} from '../src/fetcher.js';

const LONG_TEXT =
  'This is a fixture paragraph with enough readable content to pass the semantic extraction threshold. '.repeat(3);

test('normalizeUrl canonicalizes protocol host default port and hash', () => {
  assert.equal(
    normalizeUrl('HTTPS://Example.COM:443/a?b=1#section'),
    'https://example.com/a?b=1'
  );
  assert.equal(normalizeUrl('not a url'), null);
});

test('extractUrls strips trailing punctuation and deduplicates canonical URLs', () => {
  const urls = extractUrls('看 https://Example.com/a， also https://example.com/a. and https://example.com/b?x=1！');

  assert.deepEqual(urls, [
    'https://example.com/a',
    'https://example.com/b?x=1',
  ]);
});

test('formatFetchedUrlDetails renders success and failure details', () => {
  const details: FetchedUrl[] = [
    {
      originalUrl: 'https://example.com/a',
      canonicalUrl: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      domain: 'example.com',
      title: 'Example',
      fetchStatus: 'fetched',
      contentLength: 7,
      error: null,
      content: 'content',
    },
    {
      originalUrl: 'https://example.com/b',
      canonicalUrl: 'https://example.com/b',
      finalUrl: null,
      domain: 'example.com',
      title: null,
      fetchStatus: 'failed',
      contentLength: 0,
      error: 'timeout',
      content: '(抓取失败: timeout)',
    },
  ];

  const text = formatFetchedUrlDetails(details);

  assert.match(text, /\[来源: https:\/\/example.com\/a\]/);
  assert.match(text, /content/);
  assert.match(text, /\[来源: https:\/\/example.com\/b\]/);
  assert.match(text, /抓取失败: timeout/);
});

test('extractReadableArticle handles WeChat js_content fixture', () => {
  const article = extractReadableArticle(`
    <html>
      <head><meta property="og:title" content="WeChat Title"></head>
      <body>
        <div id="js_content">
          <p>微信正文第一段</p>
          <div class="qr_code_pc">QR should disappear</div>
          <p>微信正文第二段</p>
        </div>
      </body>
    </html>
  `, 'https://mp.weixin.qq.com/s/example');

  assert.equal(article.title, 'WeChat Title');
  assert.match(article.text, /标题: WeChat Title/);
  assert.match(article.text, /微信正文第一段/);
  assert.doesNotMatch(article.text, /QR should disappear/);
});

test('extractReadableArticle handles article fixture', () => {
  const article = extractReadableArticle(`
    <html>
      <head><title>Article Title</title></head>
      <body>
        <article><h1>Ignored H1</h1><p>${LONG_TEXT}</p><aside class="sidebar">remove me</aside></article>
      </body>
    </html>
  `, 'https://example.com/article');

  assert.equal(article.title, 'Article Title');
  assert.match(article.text, /Article Title/);
  assert.match(article.text, /fixture paragraph/);
  assert.doesNotMatch(article.text, /remove me/);
});

test('extractReadableArticle handles main fixture', () => {
  const article = extractReadableArticle(`
    <html>
      <body>
        <h1>Main Title</h1>
        <main><p>${LONG_TEXT}</p><footer>footer noise</footer></main>
      </body>
    </html>
  `, 'https://sspai.com/post/example');

  assert.equal(article.title, 'Main Title');
  assert.match(article.text, /fixture paragraph/);
  assert.doesNotMatch(article.text, /footer noise/);
});

test('extractReadableArticle handles role main fixture', () => {
  const article = extractReadableArticle(`
    <html>
      <head><title>Role Main Title</title></head>
      <body>
        <div role="main"><p>${LONG_TEXT}</p><nav>navigation noise</nav></div>
      </body>
    </html>
  `, 'https://juejin.cn/post/example');

  assert.equal(article.title, 'Role Main Title');
  assert.match(article.text, /fixture paragraph/);
  assert.doesNotMatch(article.text, /navigation noise/);
});

test('extractReadableArticle falls back to body fixture', () => {
  const article = extractReadableArticle(`
    <html>
      <head><title>Body Title</title></head>
      <body>
        <header>header noise</header>
        <section><p>Short body text still appears through fallback.</p></section>
      </body>
    </html>
  `, 'https://zhihu.com/question/example');

  assert.equal(article.title, 'Body Title');
  assert.match(article.text, /Short body text/);
  assert.doesNotMatch(article.text, /header noise/);
});
