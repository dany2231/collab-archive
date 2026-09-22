// data/의 게임·IP·콜라보 파일을 대시보드용 site/data/dashboard.json 하나로 묶는다.
// 대시보드는 한국어만 보여야 하므로 원문 별칭 같은 필드는 빼고, 남은 텍스트에 가나가 섞이면 빌드를 실패시킨다.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson, writeJson } from '../crawlers/lib/output.mjs';

const ROOT = resolve(import.meta.dirname, '..');
export const FORMS = ['인게임', '식음료', '카페·팝업', '굿즈·하드웨어', '브랜드', '음악', '기타'];
// URL, ID, 날짜처럼 표시용 텍스트가 아닌 값은 검사하지 않는다.
const NOT_TEXT = new Set(['id', 'ip', 'game', 'url', 'locale', 'date', 'generated']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];

const games = await readJson(resolve(ROOT, 'data/games.json'), []);
const ips = new Map((await readJson(resolve(ROOT, 'data/ips.json'), [])).map(ip => [ip.id, ip]));
const collabs = [];
const campaigns = [];
const files = (await readdir(resolve(ROOT, 'data/collabs'))).filter(file => file.endsWith('.json'));
for (const file of files) {
  const data = await readJson(resolve(ROOT, 'data/collabs', file), null);
  const game = games.find(entry => entry.id === data.game);
  if (!game) { errors.push(`${file}: unknown game ${data.game}`); continue; }
  if (!data.reviewed) warnings.push(`${file}: reviewed가 false입니다 (검토 전 초안)`);
  const campaignNames = new Map(data.campaigns.map(campaign => [campaign.id, campaign.name]));
  for (const campaign of data.campaigns) campaigns.push({ game: data.game, ...campaign });
  for (const collab of data.collabs) {
    const ip = ips.get(collab.ip);
    if (!ip) errors.push(`${collab.id}: ips.json에 ${collab.ip}가 없습니다`);
    if (!FORMS.includes(collab.form)) errors.push(`${collab.id}: 알 수 없는 형태 ${collab.form} (${FORMS.join(', ')})`);
    // date는 콜라보 시작일, 모르면 공지일이다.
    if (!DATE.test(collab.date ?? '')) errors.push(`${collab.id}: date 날짜 형식 오류 ${collab.date}`);
    if (collab.campaign && !campaignNames.has(collab.campaign)) errors.push(`${collab.id}: 알 수 없는 캠페인 ${collab.campaign}`);
    collabs.push({
      ...collab,
      game: data.game,
      partner: ip?.ko ?? collab.ip,
      partner_category: ip?.category ?? '',
      campaign: collab.campaign ? { id: collab.campaign, name: campaignNames.get(collab.campaign) } : null,
    });
  }
}

const dashboard = {
  generated: new Date().toISOString(),
  forms: FORMS,
  games: games.map(({ id, name }) => ({ id, name })),
  collabs: collabs.sort((a, b) => b.date.localeCompare(a.date)),
  campaigns,
};

(function check(value, path) {
  if (typeof value === 'string') {
    const key = path.split('.').pop().replace(/\[\d+\]$/, '');
    if (NOT_TEXT.has(key)) return;
    if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(value)) errors.push(`${path}: 일본어가 섞여 있습니다 "${value}"`);
    else if (/\p{L}/u.test(value) && !/[\uac00-\ud7a3]/.test(value)) warnings.push(`${path}: 한글이 없습니다 "${value}"`);
  } else if (Array.isArray(value)) value.forEach((item, index) => check(item, `${path}[${index}]`));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) check(item, path ? `${path}.${key}` : key);
})(dashboard, '');

for (const warning of warnings) console.warn(`경고: ${warning}`);
if (errors.length) {
  for (const error of errors) console.error(`오류: ${error}`);
  process.exit(1);
}
await writeJson(resolve(ROOT, 'site/data/dashboard.json'), dashboard);
console.log(`site/data/dashboard.json: 게임 ${games.length}개, 콜라보 ${collabs.length}건, 캠페인 ${campaigns.length}개`);
