import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { cli } from '../../lib/cli.mjs';
import { matchArticle } from '../../lib/keywords.mjs';
import { csv, isoDate, readJson, writeJson, mergeCandidates } from '../../lib/output.mjs';
import { htmlToText } from '../../lib/text.mjs';
import { TRANSLATE_ARGS, TRANSLATE_IGNORE_DEFAULT_ARGS, declarePageLanguage, enableAlwaysTranslate, promptTranslation, waitForTranslatedClass, waitForTranslation } from '../../lib/translate.mjs';

// 1단계: 뉴스 페이지가 내부적으로 쓰는 목록 API로 모든 기사의 원문 제목과 본문을 받아 키워드 후보를 고른다. 브라우저를 쓰지 않는다.
// 2단계: 후보 기사만 브라우저에서 열어 Chrome 번역으로 한국어 제목과 본문을 얻는다.
// 번역에 실패한 기사는 멈추지 않고 기록한 뒤 넘어가고, 마지막에 새 탭으로 한 번 더 시도한다. 남은 실패는 다음 실행 때 다시 시도한다.
const GAME = 'zenless';
const ROOT = resolve(import.meta.dirname, '../../..');
const LOCALES = ['ko-kr', 'ja-jp', 'en-us'];

// 호요랩·미유서 공식 게시물은 공통 실행부가 처리한다. 공식 사이트에 없는 콜라보 공지가
// 여기에만 올라오는 일이 많다. gids 8은 젠레스 존 제로다.
if (process.argv.slice(2).join(' ').includes('hoyolab')) {
  const { crawlHoyoContent, hoyolabGlobal, hoyolabCn } = await import('../../lib/hoyo-content.mjs');
  await crawlHoyoContent({
    game: GAME, root: ROOT,
    sources: { 'hoyolab-ko': hoyolabGlobal({ gids: 8 }), 'hoyolab-zh': hoyolabCn({ gids: 8, slug: 'zzz' }) },
  });
  process.exit(process.exitCode ?? 0);
}
// 사이트 번들에 들어 있는 앱 ID (2026-09-18 확인). API가 실패하면 뉴스 페이지의 getContentList 요청에서 새 값을 확인한다.
const API = 'https://sg-public-api-static.hoyoverse.com/content_v2_user/app/3e9196a4b9274bd7/getContentList';
const PAGE_SIZE = 100;
// 탭별 category ID는 언어와 무관하다 (2026-09-18 확인). 콜라보 공지는 대부분 뉴스 탭에 올라온다.
const CATEGORIES = { news: '295', notices: '296', events: '297' };

const args = cli();
const locale = args.option('--locale', 'en-us');
if (!LOCALES.includes(locale)) throw new Error(`--locale must be one of ${LOCALES.join(', ')}`);
const categoryOption = args.option('--category', 'news,events');
const categories = (categoryOption === 'all' ? Object.keys(CATEGORIES) : categoryOption.split(',')).map(name => {
  const id = CATEGORIES[name.trim()] ?? name.trim();
  if (!/^\d+$/.test(id)) throw new Error(`--category must be all or a list of ${Object.keys(CATEGORIES).join(', ')} or numeric IDs`);
  return id;
});
const needsTranslation = !locale.startsWith('ko');
const maxPages = args.positive('--max-pages', Number.MAX_SAFE_INTEGER);
const delay = args.positive('--delay-ms', 1000);
const protocolTimeout = args.positive('--protocol-timeout-ms', 180000);
const out = resolve(ROOT, args.option('--output-dir', `raw/${GAME}/${locale}`));
const candidatesFile = resolve(ROOT, 'data/candidates', `${GAME}.json`);
await mkdir(out, { recursive: true });
const checkpoint = resolve(out, 'progress.json');
const articleUrl = id => `https://zenless.hoyoverse.com/${locale}/news/${id}`;

// articles: 목록 API 결과와 원문 키워드 매칭, translated: 후보의 한국어 번역, failed: 번역 실패 기록
let state = { version: 4, locale, articles: {}, translated: {}, failed: {} };
if (!args.flag('--fresh')) {
  const saved = await readJson(checkpoint, null);
  if (saved?.version === 3 && saved.locale === locale) {
    // 이전 방식에서 이미 번역해 둔 기사는 다시 열지 않는다.
    for (const row of Object.values(saved.checked)) {
      if (row.title_ko) state.translated[row.url] = { title_ko: row.title_ko, excerpt_ko: row.matched && row.scope === 'full' ? row.excerpt : '' };
    }
  } else if (saved) {
    if (saved.version !== 4 || saved.locale !== locale) throw new Error('Incompatible progress file. Use --fresh or another --output-dir.');
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
  translation: state.translated[row.url] ? 'done' : state.failed[row.url] ? 'failed' : 'pending',
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
    ['date', 'title_ko', 'title_original', 'url', 'translation', 'matched_in', 'keyword', 'confidence', 'excerpt_ko', 'excerpt']));
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

// ── 1단계: 목록 API ──
let listingComplete = true;
for (const category of categories) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${API}?iPageSize=${PAGE_SIZE}&iPage=${page}&iChanId=${category}&sLangKey=${locale}`;
    const data = await retry(async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json.retcode !== 0 || !Array.isArray(json.data?.list)) throw new Error(`API error ${json.retcode}: ${json.message}`);
      return json.data;
    }, `List ${category} page ${page}`);
    for (const item of data.list) {
      const row = { id: item.iInfoId, url: articleUrl(item.iInfoId), title: item.sTitle.trim(), date: isoDate(item.dtStartTime), category };
      state.articles[row.url] = { ...row, ...matchArticle([row.title], htmlToText(item.sContent)) };
    }
    const pages = Math.ceil(data.iTotal / PAGE_SIZE);
    console.log(`Category ${category} page ${page}/${pages}: ${Object.keys(state.articles).length} articles`);
    if (page >= pages) break;
    if (page === maxPages) listingComplete = false;
    await sleep(500);
  }
}
await save();
const matched = Object.values(state.articles).filter(row => row.matched);
console.log(`\n${matched.length} candidates from ${Object.keys(state.articles).length} articles`);

// ── 2단계: 후보 번역 ──
const pending = () => matched.filter(row => !state.translated[row.url]);
let browser;
let fatal;
try {
  if (!needsTranslation || !pending().length) {
    // 한국어 원문은 번역이 필요 없다.
    if (!needsTranslation) for (const row of matched) state.translated[row.url] ??= { title_ko: row.title, excerpt_ko: row.excerpt };
  } else {
    const profileDir = resolve(ROOT, '.chrome-profile');
    await enableAlwaysTranslate(profileDir, locale.slice(0, 2));
    browser = await puppeteer.launch({
      headless: false,
      // 번역 기능은 설치된 정식 Chrome에만 있다.
      channel: 'chrome',
      userDataDir: profileDir,
      args: TRANSLATE_ARGS,
      ignoreDefaultArgs: TRANSLATE_IGNORE_DEFAULT_ARGS,
      pipe: true,
      protocolTimeout,
    });
    let detail;
    async function newTab() {
      await detail?.close().catch(() => {});
      detail = await browser.newPage();
      detail.setDefaultTimeout(30000);
      detail.setDefaultNavigationTimeout(60000);
      await detail.setViewport({ width: 1440, height: 1000 });
      await declarePageLanguage(detail, locale.slice(0, 2));
    }
    async function openArticle(url) {
      const response = await detail.goto(url, { waitUntil: 'domcontentloaded' });
      if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
      await detail.waitForFunction(() =>
        document.querySelector('.news-detail__title')?.textContent.trim() &&
        document.querySelector('.news-detail__content')?.childNodes.length,
        { polling: 250, timeout: 60000 });
    }
    async function translateArticle(row, timeout) {
      await retry(() => openArticle(row.url), row.url);
      if (!await waitForTranslatedClass(detail)) throw new Error('Translation not applied');
      const translation = await waitForTranslation(detail, '.news-detail__content', { timeout });
      if (!translation.ok) throw new Error(`Translation incomplete (hangul ratio ${translation.ratio.toFixed(2)})`);
      const result = await detail.evaluate(() => ({
        title: document.querySelector('.news-detail__title').innerText.trim(),
        body: document.querySelector('.news-detail__content').innerText,
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
    // 처음 한 번만 번역 상태를 확인한다. 자동 번역이 안 되면 사용자가 켤 때까지 기다린다.
    const first = pending()[0];
    await retry(() => openArticle(first.url), first.url);
    if (await waitForTranslatedClass(detail)) console.log('자동 번역이 감지되어 바로 진행합니다.');
    else await promptTranslation(detail, `[${locale}] 첫 기사에서 번역을 켜야 합니다.`);

    const firstFailed = new Set(Object.keys(state.failed));
    await pass(pending().filter(row => !firstFailed.has(row.url)), 20000, 'Translate');
    // 실패한 기사는 새 탭에서 더 긴 대기 시간으로 한 번 더 시도한다. 이전 실행에서 실패한 기사도 여기서 처리한다.
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
  try { await save(); } finally { await browser?.close(); }
}

const summary = {
  complete: !fatal && listingComplete && pending().length === 0,
  locale,
  categories: categoryOption,
  listingComplete,
  articles: Object.keys(state.articles).length,
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
