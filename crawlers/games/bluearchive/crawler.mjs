import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { cli } from '../../lib/cli.mjs';
import { matchArticle } from '../../lib/keywords.mjs';
import { csv, readJson, writeJson, mergeCandidates } from '../../lib/output.mjs';
import { htmlToText } from '../../lib/text.mjs';
import { serveArticles } from '../../lib/local-page.mjs';
import { TRANSLATE_ARGS, TRANSLATE_IGNORE_DEFAULT_ARGS, declarePageLanguage, enableAlwaysTranslate, promptTranslation, waitForTranslatedClass, waitForTranslation } from '../../lib/translate.mjs';

// 한국어(ko-kr)는 넥슨 포럼 API, 일본어(ja-jp)는 공식 사이트 API를 쓴다.
// 포럼은 목록에 제목만 있어서 본문은 글마다 따로 받고, 일본 API는 목록에 본문까지 들어 있다.
// 한국어 공지는 번역이 필요 없고, 일본어 후보만 Chrome 번역으로 한국어 제목을 얻는다.
// 일본 기사 페이지는 직접 열면 본문이 렌더링되지 않아, 받아 둔 본문을 로컬 페이지로 띄워 번역한다.
const GAME = 'bluearchive';
const ROOT = resolve(import.meta.dirname, '../../..');
const KR_API = 'https://forum.nexon.com/api/v1';
const KR_THREAD_URL = id => `https://forum.nexon.com/bluearchive/board_view?thread=${id}`;
const KR_BOARDS = { notice: { id: 1018, name: '공지사항' }, events: { id: 1039, name: '진행 이벤트' }, past: { id: 1053, name: '종료 이벤트' } };
const JP_API = 'https://api-web.bluearchive.jp/api/news/list';
const JP_TYPES = { events: { id: 1, name: '이벤트' }, notices: { id: 2, name: '공지' }, maintenance: { id: 3, name: '점검' } };
const PAGE_SIZE = 100;
// 한국과 일본 모두 UTC+9라 그 시간대 기준 날짜로 맞춘다.
const dayIn9 = ms => new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);

const args = cli();
const locale = args.option('--locale', 'ko-kr');
if (!['ko-kr', 'ja-jp'].includes(locale)) throw new Error('--locale must be ko-kr or ja-jp');
const needsTranslation = locale === 'ja-jp';
const sources = locale === 'ko-kr' ? KR_BOARDS : JP_TYPES;
// 점검 공지는 패치·점검 안내라 기본에서 뺀다.
const categoryOption = args.option('--category', locale === 'ko-kr' ? 'notice,events,past' : 'events,notices');
const categories = (categoryOption === 'all' ? Object.keys(sources) : categoryOption.split(',')).map(name => {
  const source = sources[name.trim()];
  if (!source) throw new Error(`--category must be all or a list of ${Object.keys(sources).join(', ')}`);
  return { key: name.trim(), ...source };
});
// 첫 실행은 본문까지 확인하고, 이후에는 --titles-only로 제목만 봐도 된다 (한국어 전용).
const titlesOnly = args.flag('--titles-only');
const maxPages = args.positive('--max-pages', Number.MAX_SAFE_INTEGER);
const delay = args.positive('--delay-ms', 1000);
const apiDelay = args.positive('--api-delay-ms', 250);
const protocolTimeout = args.positive('--protocol-timeout-ms', 180000);
const out = resolve(ROOT, args.option('--output-dir', `raw/${GAME}/${locale}`));
const candidatesFile = resolve(ROOT, 'data/candidates', `${GAME}.json`);
await mkdir(out, { recursive: true });
const checkpoint = resolve(out, 'progress.json');
// 한국 공지에서 확인한 콜라보 상대의 원문 표기. 일본 공지는 'コラボ' 없이 작품명만 적는 경우가 많다.
const aliases = await readJson(resolve(ROOT, 'data/aliases', `${GAME}.json`), []);
if (aliases.length) console.log(`별칭 ${aliases.length}개를 함께 검색합니다`);

let state = { version: 1, locale, articles: {}, translated: {}, failed: {} };
if (!args.flag('--fresh')) {
  const saved = await readJson(checkpoint, null);
  if (saved) {
    if (saved.version !== 1 || saved.locale !== locale) throw new Error('Incompatible progress file. Use --fresh or another --output-dir.');
    state = saved;
  }
}

const candidates = () => Object.values(state.articles).filter(row => row.matched).map(row => ({
  game: GAME,
  locale,
  url: row.url,
  date: row.date,
  category: row.category,
  title_original: row.title,
  title_ko: state.translated[row.url]?.title_ko || '',
  translation: needsTranslation ? (state.translated[row.url] ? 'done' : state.failed[row.url] ? 'failed' : 'pending') : 'none',
  matched_in: row.matched_in,
  keyword: row.keyword,
  confidence: row.confidence,
  excerpt: row.excerpt,
  excerpt_ko: state.translated[row.url]?.excerpt_ko || '',
}));
async function save() {
  await writeJson(checkpoint, state);
  await writeJson(resolve(out, 'errors.json'), state.failed);
  const rows = candidates();
  await writeFile(resolve(out, 'candidates.csv'), csv(rows,
    ['date', 'title_ko', 'title_original', 'url', 'category', 'matched_in', 'keyword', 'confidence', 'excerpt_ko', 'excerpt']));
  await mergeCandidates(candidatesFile, locale, rows);
}
async function retry(fn, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt === 3) throw error;
      console.error(`${label}: attempt ${attempt} failed: ${error.message}`);
      await sleep(delay * attempt * 2);
    }
  }
}
const json = (url, label) => retry(async () => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}, label);

// ── 1단계: 목록과 키워드 후보 ──
let listingComplete = true;
let bodyChecked = 0;
if (locale === 'ko-kr') {
  for (const board of categories) {
    // 2페이지부터는 직전 응답의 blockStartKey·blockStartNo를 같이 보내야 한다. 없으면 HTTP 400이 난다.
    let block = null;
    for (let page = 1; page <= maxPages; page++) {
      const paging = block ? `&blockStartKey=${encodeURIComponent(block.key)}&blockStartNo=${block.no}` : '';
      const data = await json(`${KR_API}/board/${board.id}/threads?alias=${GAME}&paginationType=PAGING&pageSize=${PAGE_SIZE}&pageNo=${page}&blockSize=5&hideType=WEB${paging}`,
        `${board.name} page ${page}`);
      block = { key: data.blockStartKey, no: data.blockStartNo };
      for (const thread of data.threads) {
        const url = KR_THREAD_URL(thread.threadId);
        const title = htmlToText(thread.title);
        state.articles[url] ??= { id: thread.threadId, url, title, date: dayIn9(thread.createDate * 1000), category: board.name };
        Object.assign(state.articles[url], matchArticle([title], '', aliases), { scope: 'title' });
      }
      console.log(`${board.name} ${page}/${data.totalPages}: ${Object.keys(state.articles).length} articles`);
      if (page >= Number(data.totalPages)) break;
      if (page === maxPages) listingComplete = false;
      await sleep(apiDelay);
    }
  }
  // 제목에 키워드가 없는 글은 본문까지 확인한다. 한 번 확인한 글은 다시 받지 않는다.
  if (!titlesOnly) {
    const pending = Object.values(state.articles).filter(row => row.scope !== 'full' && !row.matched);
    for (const [index, row] of pending.entries()) {
      try {
        const detail = await json(`${KR_API}/thread/${row.id}?alias=${GAME}`, row.url);
        Object.assign(row, matchArticle([row.title], htmlToText(detail.content), aliases), { scope: 'full' });
        bodyChecked++;
        if (row.matched) console.log(`MATCH ${row.title}`);
      } catch (error) {
        console.error(`본문 확인 실패 ${row.url}: ${error.message}`);
      }
      if (index % 50 === 49) { console.log(`본문 확인 ${index + 1}/${pending.length}`); await save(); }
      await sleep(apiDelay);
    }
  }
} else {
  for (const type of categories) {
    for (let page = 1; page <= maxPages; page++) {
      const data = (await json(`${JP_API}?typeId=${type.id}&pageNum=${PAGE_SIZE}&pageIndex=${page}`, `${type.name} page ${page}`)).data;
      for (const row of data.rows) {
        // title은 분류 이름("イベント"), summary가 기사 제목이다.
        const url = `https://bluearchive.jp/news/detail/${row.id}`;
        const match = matchArticle([row.summary], htmlToText(row.content), aliases);
        state.articles[url] = {
          id: row.id, url, title: htmlToText(row.summary), date: dayIn9(row.publishTime),
          category: type.name, scope: 'full', ...match,
          // 본문은 번역에 쓰는 후보만 남긴다. 전체를 담으면 진행 파일이 수 MB가 된다.
          ...(match.matched ? { html: row.content } : {}),
        };
        bodyChecked++;
      }
      const pages = Math.ceil(data.count / PAGE_SIZE);
      console.log(`${type.name} ${page}/${pages}: ${Object.keys(state.articles).length} articles`);
      if (page >= pages) break;
      if (page === maxPages) listingComplete = false;
      await sleep(apiDelay);
    }
  }
}
await save();
const matched = Object.values(state.articles).filter(row => row.matched);
console.log(`\n${matched.length} candidates from ${Object.keys(state.articles).length} articles`);

// ── 2단계: 후보 번역 (일본어만) ──
const pending = () => matched.filter(row => !state.translated[row.url]);
let browser;
let site;
let fatal;
try {
  if (!needsTranslation) {
    for (const row of matched) state.translated[row.url] ??= { title_ko: row.title, excerpt_ko: row.excerpt };
  } else if (pending().length) {
    const profileDir = resolve(ROOT, '.chrome-profile');
    await enableAlwaysTranslate(profileDir, 'ja');
    site = await serveArticles('ja');
    browser = await puppeteer.launch({
      headless: false,
      channel: 'chrome',
      userDataDir: profileDir,
      args: TRANSLATE_ARGS,
      ignoreDefaultArgs: TRANSLATE_IGNORE_DEFAULT_ARGS,
      pipe: true,
      protocolTimeout,
    });
    let page;
    async function newTab() {
      await page?.close().catch(() => {});
      page = await browser.newPage();
      page.setDefaultTimeout(30000);
      page.setDefaultNavigationTimeout(60000);
      await page.setViewport({ width: 1440, height: 1000 });
      await declarePageLanguage(page, 'ja');
    }
    async function open(row) {
      const response = await page.goto(site.url(row.id, { title: row.title, html: row.html }), { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      await page.waitForSelector('#content');
    }
    async function translateArticle(row, timeout) {
      await retry(() => open(row), row.url);
      if (!await waitForTranslatedClass(page)) throw new Error('Translation not applied');
      const translation = await waitForTranslation(page, '#content', { timeout });
      if (!translation.ok) throw new Error(`Translation incomplete (hangul ratio ${translation.ratio.toFixed(2)})`);
      const result = await page.evaluate(() => ({
        title: document.querySelector('#title').innerText.trim(),
        body: document.querySelector('#content').innerText,
      }));
      return { title_ko: result.title, excerpt_ko: matchArticle([result.title], result.body).excerpt };
    }
    async function pass(rows, timeout, label) {
      for (const [index, row] of rows.entries()) {
        await sleep(delay);
        try {
          state.translated[row.url] = await translateArticle(row, timeout);
          delete state.failed[row.url];
          console.log(`${label} ${index + 1}/${rows.length}: ${state.translated[row.url].title_ko}`);
        } catch (error) {
          if (!browser.connected) throw error;
          const attempts = (state.failed[row.url]?.attempts || 0) + 1;
          state.failed[row.url] = { title: row.title, reason: error.message, attempts, at: new Date().toISOString() };
          console.error(`${label} ${index + 1}/${rows.length} skipped (${error.message}): ${row.title}`);
        }
        await save();
      }
    }

    await newTab();
    const first = pending()[0];
    await retry(() => open(first), first.url);
    if (await waitForTranslatedClass(page)) console.log('자동 번역이 감지되어 바로 진행합니다.');
    else await promptTranslation(page, '[ja-jp] 첫 기사에서 번역을 켜야 합니다.');

    const firstFailed = new Set(Object.keys(state.failed));
    await pass(pending().filter(row => !firstFailed.has(row.url)), 20000, 'Translate');
    if (pending().length) {
      console.log(`\nRetrying ${pending().length} failed articles in a new tab...`);
      await newTab();
      await pass(pending(), 45000, 'Retry');
    }
  }
} catch (error) {
  fatal = error;
  console.error(error.stack);
} finally {
  try { await save(); } finally { await browser?.close(); site?.close(); }
}

const summary = {
  complete: !fatal && listingComplete && pending().length === 0,
  locale,
  categories: categoryOption,
  listingComplete,
  articles: Object.keys(state.articles).length,
  bodyChecked,
  candidates: matched.length,
  translated: matched.length - pending().length,
  translationFailed: pending().filter(row => state.failed[row.url]).length,
  error: fatal?.message || null,
};
await writeJson(resolve(out, 'summary.json'), summary);
console.log(JSON.stringify(summary, null, 2));
if (summary.translationFailed) console.log(`번역 실패 목록: ${resolve(out, 'errors.json')} (다시 실행하면 이 기사들만 재시도합니다)`);
console.log(`Candidates: ${candidatesFile}`);
if (!summary.complete) process.exitCode = 1;
