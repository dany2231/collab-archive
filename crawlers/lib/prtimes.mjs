import { setTimeout as sleep } from 'node:timers/promises';
import { htmlToText } from './text.mjs';

// PR TIMES(일본 보도자료 플랫폼) 목록. 공식 사이트에 올라오지 않는 일본 오프라인 콜라보가
// 파트너사·굿즈 제작사 이름으로 여기 올라온다 (예: 블루 아카이브 × ZOZOTOWN, 팝업 스토어).
//
// 두 경로를 함께 쓴다. 검색은 최신만, 회사 RSS는 그 회사의 과거분을 덮는다.
//  - 키워드 검색: 한 번에 40건까지만 준다. 페이지 넘김 수단이 없다(2026-09-23 확인).
//  - 회사별 RSS(companyrdf.php): 회사마다 최근 200건. 보도자료가 잦은 회사일수록 짧은 기간만 남는다.
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://prtimes.jp/' };
const SEARCH = 'https://prtimes.jp/main/action.php?run=html&page=searchkey&search_word=';
const COMPANY_RSS = 'https://prtimes.jp/companyrdf.php?company_id=';
export const releaseUrl = id => `https://prtimes.jp/main/html/rd/p/${id}.html`;

async function fetchText(url, label) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return response.text();
}

// "2026年9月14日 13時00分" → 2026-09-14
const japaneseDate = text => {
  const [, y, m, d] = text.match(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/) ?? [];
  return y ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
};

function parseSearch(html) {
  return html.split('<article').slice(1).map(block => ({
    id: (block.match(/\/main\/html\/rd\/p\/([\d.]+)\.html/) ?? [])[1] ?? '',
    title: htmlToText((block.match(/_title_[^"]*">([^<]+)</) ?? [])[1] ?? ''),
    date: japaneseDate((block.match(/<time>([^<]+)</) ?? [])[1] ?? ''),
    company: htmlToText((block.match(/company_id\/\d+">([^<]+)</) ?? [])[1] ?? ''),
  })).filter(row => row.id);
}

function parseRss(xml) {
  return xml.split('<item').slice(1).map(block => ({
    id: (block.match(/\/main\/html\/rd\/p\/([\d.]+)\.html/) ?? [])[1] ?? '',
    title: htmlToText((block.match(/<title>([\s\S]*?)<\/title>/) ?? [])[1] ?? ''),
    date: ((block.match(/<dc:date>([\d-]{10})/) ?? [])[1]) ?? '',
    company: htmlToText((block.match(/<dc:publisher>([\s\S]*?)<\/dc:publisher>/) ?? [])[1] ?? ''),
  })).filter(row => row.id);
}

// 보도자료 본문과 전체 제목. 목록의 제목은 "…がねん…"처럼 잘려 나와서 그대로 쓰면
// 본문 검사도, 피규어 걸러내기도 어긋난다. 그래서 상세 페이지에서 원래 제목을 다시 받는다.
export async function releaseDetail(id) {
  const html = await fetchText(releaseUrl(id), `release ${id}`);
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? html;
  return {
    title: htmlToText(html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? ''),
    body: htmlToText(main.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')).slice(0, 4000),
  };
}

// 피규어·프라모델 발매 보도자료. 상대 브랜드가 없는 라이선스 상품이라 콜라보로 보지 않는다.
// 제작사(굿스마일 등) RSS의 대부분이 이쪽이어서 본문을 받기 전에 걸러낸다.
export const FIGURE = /フィギュア|ねんどろいど|figma|POP UP PARADE|スケール|プラモデル|立体化|ソフビ|ぬいぐるみ/i;

// config: { game: ['ブルアカ', ...], keywords: [...], companies: [{ id, name }], skip }
export async function* listPrTimes(source, locale, { categories, maxPages, retry, apiDelay }) {
  const seen = new Set();
  const isGame = title => source.game.some(name => title.includes(name)) && !source.skip?.test(title);
  for (const channel of categories) {
    const pages = channel.id === 'search'
      ? source.keywords.map(word => ({ label: `검색 "${word}"`, load: () => fetchText(SEARCH + encodeURIComponent(word), word).then(parseSearch) }))
      : source.companies.map(company => ({ label: `RSS ${company.name}`, load: () => fetchText(COMPANY_RSS + company.id, company.name).then(parseRss) }));
    for (const [index, page] of pages.entries()) {
      if (index >= maxPages) return false;
      const rows = await retry(page.load, page.label);
      // 게임 이름이 제목에 없는 보도자료는 버린다. 남은 것만 본문을 받는다.
      const mine = rows.filter(row => isGame(row.title) && !seen.has(row.id));
      const detailed = [];
      for (const row of mine) {
        seen.add(row.id);
        const detail = await retry(() => releaseDetail(row.id), `release ${row.id}`);
        const title = detail.title || row.title;
        // 목록에서 잘린 제목에 가려 있던 피규어 발매는 여기서 걸러진다.
        if (source.skip?.test(title)) continue;
        detailed.push({
          id: row.id, url: releaseUrl(row.id), title, date: row.date,
          category: `${channel.name}·${row.company}`, html: detail.body,
        });
        await sleep(apiDelay);
      }
      yield { label: `${page.label} ${detailed.length}/${rows.length}`, rows: detailed };
      await sleep(apiDelay);
    }
  }
  return true;
}

export const prtimes = ({ game, keywords, companies, skip = FIGURE }) => ({
  prtimes: true, game, keywords, companies, skip, lang: 'ja',
  channels: { search: { id: 'search', name: '검색' }, companies: { id: 'companies', name: 'RSS' } },
  defaults: 'search,companies',
  url: id => releaseUrl(id),
});
