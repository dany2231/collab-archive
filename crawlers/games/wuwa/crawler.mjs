import { resolve } from 'node:path';
import { crawlContentApi, kuroSite } from '../../lib/content-api.mjs';
import { prtimes } from '../../lib/prtimes.mjs';

// 공식 사이트가 읽는 정적 JSON에서 확인했다 (2026-10-06).
// https://hw-media-cdn-mingchao.kurogame.com/akiwebsite/website2.0/json/G152/{언어}/ArticleMenu.json
// 게임 ID는 G152이고, 언어 코드는 kr·jp·en이다. 한 파일에 전체 기사와 본문이 들어 있다.
const SITE = 'https://wutheringwaves.kurogames.com';

await crawlContentApi({
  game: 'wuwa',
  root: resolve(import.meta.dirname, '../../..'),
  sources: {
    'ko-kr': kuroSite({ game: 'G152', language: 'kr', site: SITE }),
    'ja-jp': kuroSite({ game: 'G152', language: 'jp', site: SITE, lang: 'ja' }),
    'en-us': kuroSite({ game: 'G152', language: 'en', site: SITE, lang: 'en' }),
    // 중국 서버는 CDN 호스트가 다르고 언어 코드가 zh다. 사이트 주소에 언어 경로가 없다.
    'zh-cn': kuroSite({ game: 'G152', language: 'zh', site: 'https://mc.kuro.com', lang: 'zh-CN', host: 'media-cdn-mingchao.kurogame.com', path: '/main' }),
    // 일본 오프라인·브랜드 콜라보는 공식 사이트에 없고 파트너사가 PR TIMES에 보도자료로 낸다 (2026-10-06 검색으로 확인).
    // 검색은 최근 40건만 주므로 과거분은 파트너사 RSS로 메운다. 쿠로 자신의 RSS는 버전 업데이트 공지가 대부분이다.
    'ja-prtimes': prtimes({
      game: ['鳴潮', 'Wuthering Waves'],
      keywords: ['鳴潮', 'Wuthering Waves', '鳴潮 コラボ', '鳴潮 ポップアップ', '鳴潮 カフェ', '鳴潮 キャンペーン'],
      companies: [
        { id: 144940, name: 'KURO TECHNOLOGY' }, { id: 143406, name: '广州库洛科技' },
        { id: 34930, name: 'GENDA GiGO' }, { id: 163154, name: 'Razer Japan' }, { id: 96287, name: 'ZOZO' },
        { id: 170901, name: 'MOONDROP' }, { id: 37526, name: '포시즌스(피자라)' }, { id: 3639, name: 'PARCO' },
        { id: 6410, name: '바이두(Simeji)' }, { id: 108434, name: '극락탕' }, { id: 25615, name: '대망(아미아미)' },
      ],
    }),
  },
});
