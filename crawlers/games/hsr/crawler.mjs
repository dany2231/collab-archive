import { resolve } from 'node:path';
import { crawlHoyoContent, hoyolabGlobal, hoyolabCn } from '../../lib/hoyo-content.mjs';

// 사이트 설정은 뉴스 페이지 요청과 번들에서 확인했다 (2026-09-21).
// 글로벌: 앱 113fe6d3b4514cdd (iAppId 없음), 채널 248 전체 / 249 뉴스 / 250 공지 / 251 이벤트
// 중국: act-api-takumi-static의 앱 1963de8dc19e461c, iAppId 238, 채널 255 전체 / 256 뉴스 / 257 공지 / 258 이벤트
const GLOBAL = { api: 'https://sg-public-api-static.hoyoverse.com/content_v2_user/app/113fe6d3b4514cdd', appId: null };
const GLOBAL_CHANNELS = {
  news: { id: 249, name: '뉴스' }, events: { id: 251, name: '이벤트' },
  notices: { id: 250, name: '공지' }, all: { id: 248, name: '전체' },
};

await crawlHoyoContent({
  game: 'hsr',
  root: resolve(import.meta.dirname, '../../..'),
  sources: {
    'ko-kr': { ...GLOBAL, channels: GLOBAL_CHANNELS, defaults: 'news,events', lang: null,
      url: id => `https://hsr.hoyoverse.com/ko-kr/news/detail/${id}` },
    'ja-jp': { ...GLOBAL, channels: GLOBAL_CHANNELS, defaults: 'news,events', lang: 'ja',
      url: id => `https://hsr.hoyoverse.com/ja-jp/news/detail/${id}` },
    'zh-cn': { api: 'https://act-api-takumi-static.mihoyo.com/content_v2_user/app/1963de8dc19e461c', appId: 238,
      channels: { news: { id: 256, name: '뉴스' }, events: { id: 258, name: '이벤트' }, notices: { id: 257, name: '공지' }, all: { id: 255, name: '전체' } },
      defaults: 'news,events', lang: 'zh-CN',
      url: id => `https://sr.mihoyo.com/main/news/detail/${id}` },
    // 공식 사이트에 없는 콜라보 공지가 호요랩에만 올라온다 (예: × 포트나이트). gids 6은 붕괴: 스타레일이다.
    'hoyolab-ko': hoyolabGlobal({ gids: 6 }),
    'hoyolab-zh': hoyolabCn({ gids: 6, slug: 'sr' }),
  },
});
