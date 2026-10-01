import { resolve } from 'node:path';
import { crawlContentApi, playerInfinite } from '../../lib/content-api.mjs';

// 공식 사이트가 쓰는 레벨 인피니트 CMS API에서 확인했다 (2026-09-23).
// 게임 ID 16, 지역 na. 분류는 상위 309(news) 아래 496(뉴스)·892(공지)이고 세 언어가 같은 ID를 쓴다.
// 언어마다 올라오는 공지가 달라서(공지 기준 한국어 258 / 일본어 273 / 영어 429건) 각각 받아야 한다.
const CHANNELS = { news: { id: 496, parent: 309, name: '뉴스' }, notices: { id: 892, parent: 309, name: '공지' } };

await crawlContentApi({
  game: 'nikke',
  root: resolve(import.meta.dirname, '../../..'),
  sources: {
    'ko-kr': playerInfinite({ gameId: 16, language: 'ko', site: 'https://nikke-kr.com', channels: CHANNELS }),
    'ja-jp': playerInfinite({ gameId: 16, language: 'ja', site: 'https://nikke-jp.com', channels: CHANNELS, lang: 'ja' }),
    'en-us': playerInfinite({ gameId: 16, language: 'en', site: 'https://nikke-en.com', channels: CHANNELS, lang: 'en' }),
  },
});
