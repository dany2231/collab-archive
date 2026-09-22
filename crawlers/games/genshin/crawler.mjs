import { resolve } from 'node:path';
import { crawlHoyoContent, hoyolabGlobal, hoyolabCn } from '../../lib/hoyo-content.mjs';

// 사이트 설정(앱 ID, iAppId, 채널 ID)은 뉴스 페이지 번들에서 확인했다 (2026-09-21).
const GLOBAL = { api: 'https://sg-public-api-static.hoyoverse.com/content_v2_user/app/a1b1f9d3315447cc', appId: 32 };
const GLOBAL_CHANNELS = { news: { id: 396, name: '뉴스' }, events: { id: 398, name: '이벤트' }, notices: { id: 397, name: '공지' } };

await crawlHoyoContent({
  game: 'genshin',
  root: resolve(import.meta.dirname, '../../..'),
  sources: {
    'ko-kr': { ...GLOBAL, channels: GLOBAL_CHANNELS, defaults: 'news,events', lang: null,
      url: id => `https://genshin.hoyoverse.com/ko/news/detail/${id}` },
    'ja-jp': { ...GLOBAL, channels: GLOBAL_CHANNELS, defaults: 'news,events', lang: 'ja',
      url: id => `https://genshin.hoyoverse.com/ja/news/detail/${id}` },
    'zh-cn': { api: 'https://act-api-takumi-static.mihoyo.com/content_v2_user/app/16471662a82d418a', appId: 43,
      channels: { news: { id: 719, name: '최신' }, notices: { id: 721, name: '공지' } },
      defaults: 'news', lang: 'zh-CN',
      url: id => `https://ys.mihoyo.com/main/news/detail/${id}` },
    // 공식 사이트에 없는 콜라보 공지가 호요랩·미유서에만 올라오는 일이 많다. gids 2는 원신이다.
    'hoyolab-ko': hoyolabGlobal({ gids: 2 }),
    'hoyolab-zh': hoyolabCn({ gids: 2, slug: 'ys' }),
  },
});
