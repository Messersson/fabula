'use strict';

// 书源链路：搜索 → 目录 → 正文抓取与清洗。
// 以前这条链路只有「联网手工试」一种验证方式，换台机器就没法复现；
// 这里用本地 HTTP 桩把选择器、相对链接、charset 与清洗规则固定下来。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabula-sources-'));
process.env.FABULA_DATA_DIR = tempDir;

let server = null;
let baseUrl = '';
let sourcesEngine = null;

const SEARCH_HTML = `<!doctype html><html><body>
  <div class="listitem">
    <div class="bookdesc"><h2>测试之书</h2><a href="/book/1/">阅读</a></div>
    <p class="sp"><span>作者甲</span></p>
  </div>
  <div class="listitem">
    <div class="bookdesc"><h2>无关条目</h2><a href="/book/2/">阅读</a></div>
    <p class="sp"><span>作者乙</span></p>
  </div>
</body></html>`;

const CATALOG_HTML = `<!doctype html><html><body>
  <h1>测试之书</h1>
  <div id="list">
    <dd><a href="/book/1/1.html">第一章 起点</a></dd>
    <dd><a href="/book/1/2.html">第二章 转折</a></dd>
  </div>
</body></html>`;

const CHAPTER_HTML = `<!doctype html><html><body>
  <div id="content">
    <p>第一段正文，带一个数字 42。</p>
    <p>第二段正文。</p>
    <p>最新网址：example.com</p>
  </div>
</body></html>`;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/search') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SEARCH_HTML);
      return;
    }
    if (url.pathname === '/book/1/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CATALOG_HTML);
      return;
    }
    if (url.pathname === '/book/1/1.html' || url.pathname === '/book/1/2.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(CHAPTER_HTML);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(tempDir, 'sources.json'), JSON.stringify([{
    id: 'local',
    name: '本地测试源',
    baseUrl: baseUrl + '/',
    charset: '',
    search: {
      url: baseUrl + '/search?wd={{key}}',
      item: 'div.listitem',
      name: '.bookdesc h2',
      link: '.bookdesc a',
      author: 'p.sp span',
    },
    catalog: { item: '#list dd a', bookName: 'h1', urlTemplate: '{{url}}/index.html' },
    content: { body: '#content', junkLines: ['最新网址'] },
  }]), 'utf-8');
  sourcesEngine = require('../lib/handlers-sources');
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('搜索按选择器提取标题、作者与相对链接', async () => {
  const items = await sourcesEngine.searchBooks({ sourceId: 'local', keyword: '测试' });
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: '测试之书',
    name: '测试之书',
    author: '作者甲',
    url: `${baseUrl}/book/1/`,
  });
});

test('目录页解析书名与章节，并把链接补成绝对地址', async () => {
  const catalog = await sourcesEngine.fetchBookCatalog({
    sourceId: 'local',
    bookUrl: `${baseUrl}/book/1/`,
  });
  assert.equal(catalog.title, '测试之书');
  assert.equal(catalog.chapters.length, 2);
  assert.equal(catalog.chapters[1].name, '第二章 转折');
  assert.equal(catalog.chapters[1].url, `${baseUrl}/book/1/2.html`);
});

test('正文抓取保留段落、去掉站点垃圾行并汇报进度', async () => {
  const events = [];
  const text = await sourcesEngine.fetchChapterTexts({
    sourceId: 'local',
    chapters: [
      { name: '第一章 起点', url: `${baseUrl}/book/1/1.html` },
      { name: '第二章 转折', url: `${baseUrl}/book/1/2.html` },
    ],
    onEvent: '__CHANNEL__:book',
  }, { send: (line) => events.push(JSON.parse(line)) });
  assert.match(text, /第一段正文，带一个数字 42。/);
  assert.match(text, /第二段正文。/);
  assert.doesNotMatch(text, /最新网址/);
  const done = events.find((entry) => entry.e && entry.e.type === 'done');
  assert.ok(done, '应发送 done 事件');
  assert.equal(done.e.texts.length, 2);
  assert.equal(done.e.errors.length, 0);
  assert.equal(events.filter((entry) => entry.e && entry.e.type === 'progress').length, 2);
});

test('非 http(s) 地址与全部失败都会被拒绝', async () => {
  await assert.rejects(() => sourcesEngine.fetchHtml('file:///etc/passwd'), /不支持的书源协议/);
  await assert.rejects(() => sourcesEngine.fetchChapterTexts({
    sourceId: 'local',
    chapters: [{ name: '坏章', url: `${baseUrl}/missing.html` }],
    onEvent: null,
  }, { send: () => {} }), /全部章节抓取失败/);
});
