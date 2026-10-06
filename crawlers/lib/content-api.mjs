import puppeteer from 'puppeteer';
import { resolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { cli } from './cli.mjs';
import { matchArticle } from './keywords.mjs';
import { csv, isoDate, readJson, writeJson, mergeCandidates } from './output.mjs';
import { htmlToText, structuredText } from './text.mjs';
import { serveArticles } from './local-page.mjs';
import { listPrTimes } from './prtimes.mjs';
import { TRANSLATE_ARGS, TRANSLATE_IGNORE_DEFAULT_ARGS, declarePageLanguage, enableAlwaysTranslate, promptTranslation, waitForTranslatedClass, waitForTranslation } from './translate.mjs';

// 목록을 받아오는 게임들의 공통 실행부. 다섯 종류의 목록 방식을 지원한다.
//  - 공식 사이트(content_v2_user): 페이지 번호로 넘긴다.
//  - 호요랩·미유서 공식 게시물(getNewsList): 커서(last_id)로 넘긴다. 공식 사이트에 올라오지 않는
//    콜라보 공지가 여기에만 있는 경우가 많다 (예: 붕괴: 스타레일 × 포트나이트).
//  - 레벨 인피니트 CMS(GetContentByLabel): offset으로 넘긴다 (니케).
//  - 쿠로 게임즈 정적 JSON(ArticleMenu.json + article/{id}.json): 목록과 본문을 따로 받는다 (명조).
//  - PR TIMES 보도자료: 검색과 회사별 RSS를 함께 읽는다 (prtimes.mjs).
// 모두 1단계에서 목록과 본문을 모아 후보를 고르고, 2단계에서 후보만 번역한다.
// 한국어 원문은 번역이 필요 없고, 일본어·중국어는 본문을 로컬 페이지로 띄워 Chrome 번역에 태운다.
const PAGE_SIZE = 100;

// 목록 API는 페이지마다 기사 배열을 준다. 두 구현 모두 { rows, label } 형태로 넘긴다.
async function* listSite(source, locale, { categories, maxPages, retry, apiDelay }) {
  for (const channel of categories) {
    for (let page = 1; page <= maxPages; page++) {
      // 사이트에 따라 iAppId를 쓰지 않는 곳이 있다 (붕괴: 스타레일 글로벌).
      const appId = source.appId ? `iAppId=${source.appId}&` : '';
      const url = `${source.api}/getContentList?${appId}iChanId=${channel.id}&iPageSize=${PAGE_SIZE}&iPage=${page}&sLangKey=${locale}`;
      const data = await retry(() => fetchJson(url, source.headers), `${channel.name} page ${page}`);
      const pages = Math.ceil(data.iTotal / PAGE_SIZE);
      yield {
        label: `${channel.name} ${page}/${pages}`,
        rows: data.list.map(row => ({
          id: row.iInfoId, url: source.url(row.iInfoId), title: htmlToText(row.sTitle),
          date: isoDate(row.dtStartTime), category: channel.name, html: row.sContent,
        })),
      };
      if (page >= pages) break;
      if (page === maxPages) return false;
      await sleep(apiDelay);
    }
  }
  return true;
}

// 호요랩은 게시물 수가 많아 페이지 번호가 없다. last_id를 물려 커서로 넘긴다.
async function* listHoyolab(source, locale, { categories, maxPages, retry, apiDelay }) {
  for (const channel of categories) {
    let lastId = '';
    for (let page = 1; page <= maxPages; page++) {
      const url = `${source.api}/getNewsList?gids=${source.gids}&page_size=20&type=${channel.id}&last_id=${lastId}`;
      const data = await retry(() => fetchJson(url, source.headers), `${channel.name} page ${page}`);
      yield {
        label: `${channel.name} ${page}`,
        rows: data.list.map(({ post }) => ({
          id: post.post_id, url: source.url(post.post_id), title: htmlToText(post.subject),
          date: isoDate(new Date(post.created_at * 1000).toISOString()), category: channel.name,
          // 리치 텍스트 게시물은 structured_content에만 본문이 있다.
          html: structuredText(post.structured_content) || post.content || post.desc || '',
        })),
      };
      if (data.is_last || !data.list.length) break;
      if (page === maxPages) return false;
      lastId = data.last_id;
      await sleep(apiDelay);
    }
  }
  return true;
}

// 호요랩·미유서의 공식 게시물 분류는 세 게임이 같다.
export const HOYOLAB_CHANNELS = {
  notices: { id: 1, name: '호요랩 공지' }, events: { id: 2, name: '호요랩 이벤트' }, info: { id: 3, name: '호요랩 정보' },
};
// 글로벌 호요랩은 x-rpc-language로 언어를 고르고, 한국어 게시물을 그대로 주므로 번역이 필요 없다.
export const hoyolabGlobal = ({ gids, language = 'ko-kr' }) => ({
  api: 'https://bbs-api-os.hoyolab.com/community/post/wapi', gids,
  headers: { 'x-rpc-language': language, Referer: 'https://www.hoyolab.com/' },
  channels: HOYOLAB_CHANNELS, defaults: 'notices,events,info',
  lang: language === 'ko-kr' ? null : language.split('-')[0],
  url: id => `https://www.hoyolab.com/article/${id}`,
});
// 중국은 미유서(bbs.miyoushe.com)이고 경로가 painter/wapi다. slug는 게시물 URL에 들어가는 게임 약칭이다.
export const hoyolabCn = ({ gids, slug }) => ({
  api: 'https://bbs-api.miyoushe.com/painter/wapi', gids,
  headers: { Referer: 'https://www.miyoushe.com/' },
  channels: HOYOLAB_CHANNELS, defaults: 'notices,events,info', lang: 'zh-CN',
  url: id => `https://www.miyoushe.com/${slug}/article/${id}`,
});

// 레벨 인피니트(플레이어인피니트) CMS. 목록이 본문(content_part)까지 주고, 언어별로 내용이 다르다.
// 한 번에 최대 20건이라 offset을 20씩 밀어가며 받는다.
const PLAYER_INFINITE_PAGE = 20;
async function* listPlayerInfinite(source, locale, { categories, maxPages, retry, apiDelay }) {
  for (const channel of categories) {
    for (let page = 1; page <= maxPages; page++) {
      const offset = (page - 1) * PLAYER_INFINITE_PAGE;
      const data = await retry(() => postJson(`${source.api}/GetContentByLabel`, source.headers, {
        language: [source.language], gameid: source.gameId, offset, get_num: PLAYER_INFINITE_PAGE,
        ext_info_type_list: [0, 1, 2], secondary_label_id: channel.id, primary_label_id: channel.parent,
      }), `${channel.name} page ${page}`);
      const list = data.info_content ?? [];
      const pages = Math.ceil((data.total_num ?? 0) / PLAYER_INFINITE_PAGE);
      yield {
        label: `${channel.name} ${page}/${pages}`,
        rows: list.map(post => ({
          id: post.content_id, url: source.url(post.content_id, channel), title: htmlToText(post.title),
          // pub_timestamp는 초 단위다.
          date: isoDate(new Date(Number(post.pub_timestamp) * 1000).toISOString()),
          category: channel.name, html: post.content_part || post.content_desc || '',
        })),
      };
      if (!list.length || page >= pages) break;
      if (page === maxPages) return false;
      await sleep(apiDelay);
    }
  }
  return true;
}

// 니케 등 레벨 인피니트 게임의 공식 사이트 소스. 언어마다 올라오는 공지가 달라 각각 받아야 한다.
export const playerInfinite = ({ gameId, area = 'na', language, site, channels, lang = null }) => ({
  api: `https://${area}-community.playerinfinite.com/api/gpts.information_feeds_svr.InformationFeedsSvr`,
  gameId: String(gameId), language, channels, defaults: Object.keys(channels).join(','), lang,
  headers: {
    'Content-Type': 'application/json;charset=utf-8',
    'X-GameId': String(gameId), 'X-AreaId': area, 'X-Source': 'pc_web', 'X-Language': language,
    Referer: `${site}/`,
  },
  url: (id, channel) => `${site}/newsdetail.html?content_id=${id}&sid=${channel.id}&from=list`,
});

// 쿠로 게임즈(명조) 공식 사이트는 언어별 ArticleMenu.json 한 파일에 전체 기사 목록을 담아 둔다.
// 다만 목록의 articleContent는 20자에서 잘려 있어서, 본문은 article/{id}.json에서 따로 받는다.
// 분류 번호가 언어마다 달라서 나누지 않고 한 묶음으로 받는다.
const KURO_CONCURRENCY = 8;
async function* listKuro(source, locale, { retry }) {
  const data = await retry(() => fetchRaw(source.api), '전체');
  if (!Array.isArray(data)) throw new Error('Unexpected ArticleMenu format');
  const base = source.api.replace(/\/ArticleMenu\.json$/, '');
  const bodies = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: KURO_CONCURRENCY }, async () => {
    while (next < data.length) {
      const row = data[next++];
      const detail = await retry(() => fetchRaw(`${base}/article/${row.articleId}.json`), `기사 ${row.articleId}`);
      bodies.set(row.articleId, detail.articleContent || '');
    }
  }));
  yield {
    label: `전체 ${data.length}건`,
    rows: data.map(row => ({
      id: row.articleId, url: source.url(row.articleId), title: htmlToText(row.articleTitle),
      date: isoDate(row.startTime || row.createTime), category: '공식 뉴스', html: bodies.get(row.articleId) || row.articleDesc || '',
    })),
  };
  return true;
}

export const kuroSite = ({ game, language, site, lang = null, host = 'hw-media-cdn-mingchao.kurogame.com', path = `/${language}/main` }) => ({
  kuro: true,
  api: `https://${host}/akiwebsite/website2.0/json/${game}/${language}/ArticleMenu.json`,
  channels: { all: { id: 'all', name: '공식 뉴스' } }, defaults: 'all', lang,
  url: id => `${site}${path}/news/detail/${id}`,
});

async function fetchRaw(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function postJson(url, headers, body) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.code !== 0 || !json.data) throw new Error(`API error ${json.code}: ${json.msg}`);
  return json.data;
}

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json = await response.json();
  if (json.retcode !== 0 || !Array.isArray(json.data?.list)) throw new Error(`API error ${json.retcode}: ${json.message}`);
  return json.data;
}

// config: { game, root, sources }  sources[locale] = { api, appId, url, channels, defaults, lang }
export async function crawlContentApi({ game: GAME, root: ROOT, sources: SOURCES }) {
  const args = cli();
  const locale = args.option('--locale', 'ko-kr');
  const source = SOURCES[locale];
  if (!source) throw new Error(`--locale must be one of ${Object.keys(SOURCES).join(', ')}`);
  const needsTranslation = Boolean(source.lang);
  const categoryOption = args.option('--category', source.defaults);
  const categories = (categoryOption === 'all' ? Object.keys(source.channels) : categoryOption.split(',')).map(name => {
    const channel = source.channels[name.trim()];
    if (!channel) throw new Error(`--category must be all or a list of ${Object.keys(source.channels).join(', ')}`);
    return channel;
  });
  const maxPages = args.positive('--max-pages', Number.MAX_SAFE_INTEGER);
  const delay = args.positive('--delay-ms', 1000);
  const apiDelay = args.positive('--api-delay-ms', 250);
  const protocolTimeout = args.positive('--protocol-timeout-ms', 180000);
  const out = resolve(ROOT, args.option('--output-dir', `raw/${GAME}/${locale}`));
  const candidatesFile = resolve(ROOT, 'data/candidates', `${GAME}.json`);
  await mkdir(out, { recursive: true });
  const checkpoint = resolve(out, 'progress.json');
  // 별칭: 게임별 파일 + 이미 알고 있는 콜라보 상대 이름 전체. "콜라보"라는 말 없이
  // 상대 이름만 적은 공지를 잡는다 (예: 포트나이트에 캐릭터가 등장한다는 안내).
  const games = await readJson(resolve(ROOT, 'data/games.json'), []);
  const self = new Set([GAME, games.find(game => game.id === GAME)?.name].filter(Boolean));
  const ips = await readJson(resolve(ROOT, 'data/ips.json'), []);
  const partners = ips.filter(ip => !self.has(ip.ko)).flatMap(ip => [ip.ko, ...(ip.aliases ?? [])]);
  // 별칭 파일은 이름 배열이거나 { terms, ignore } 형태다. ignore에는 게임 안의 고유명사와
  // 겹쳐서 매번 오탐을 내는 브랜드 이름을 적는다.
  const file = await readJson(resolve(ROOT, 'data/aliases', `${GAME}.json`), []);
  const { terms = [], ignore = [] } = Array.isArray(file) ? { terms: file } : file;
  const skip = new Set([...ignore, ...self]);
  const aliases = [...new Set([...terms, ...partners])].filter(term => term.length > 1 && !skip.has(term));
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
  // 중국 API는 사내망에서 접속이 끊기는 일이 잦아 넉넉히 재시도한다.
  async function retry(fn, label, attempts = 8) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try { return await fn(); }
      catch (error) {
        if (attempt === attempts) throw error;
        console.error(`${label}: attempt ${attempt} failed: ${error.message}`);
        await sleep(delay * attempt * 2);
      }
    }
  }

  // ── 1단계: 목록과 키워드 후보 (브라우저 없음) ──
  const list = source.prtimes ? listPrTimes : source.kuro ? listKuro : source.gameId ? listPlayerInfinite : source.gids ? listHoyolab : listSite;
  const pages = list(source, locale, { categories, maxPages, retry, apiDelay });
  let listingComplete = true;
  while (true) {
    const { value, done } = await pages.next();
    if (done) { listingComplete = value !== false; break; }
    for (const row of value.rows) {
      const match = matchArticle([row.title], htmlToText(row.html), aliases);
      state.articles[row.url] = {
        ...row, ...match,
        // 본문은 번역에 쓰는 후보만 남긴다.
        ...(match.matched ? { html: row.html } : { html: undefined }),
      };
    }
    console.log(`${value.label}: ${Object.keys(state.articles).length} articles`);
  }
  await save();
  const matched = Object.values(state.articles).filter(row => row.matched);
  console.log(`\n${matched.length} candidates from ${Object.keys(state.articles).length} articles`);

  // ── 2단계: 후보 번역 ──
  const pending = () => matched.filter(row => !state.translated[row.url]);
  let browser;
  let site;
  let fatal;
  try {
    if (!needsTranslation) {
      for (const row of matched) state.translated[row.url] ??= { title_ko: row.title, excerpt_ko: row.excerpt };
    } else if (pending().length) {
      const profileDir = resolve(ROOT, '.chrome-profile');
      await enableAlwaysTranslate(profileDir, source.lang);
      site = await serveArticles(source.lang);
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
        await declarePageLanguage(page, source.lang);
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
      else await promptTranslation(page, `[${locale}] 첫 기사에서 번역을 켜야 합니다.`);

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
  return summary;

}
