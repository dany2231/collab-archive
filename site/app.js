const LOCALES = [['ko-kr', '한국어'], ['ja-jp', '일본어'], ['en-us', '영어'], ['zh-cn', '중국어']];
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const now = new Date();
const today = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const dotted = date => date.replaceAll('-', '.');
const time = date => Date.parse(date + 'T00:00:00');

// ── 테마: 시스템 → 라이트 → 다크 ──
const THEMES = [['', '테마: 시스템'], ['light', '테마: 라이트'], ['dark', '테마: 다크']];
let theme = 'dark';
try { theme = localStorage.getItem('collab-atlas-theme') ?? 'dark'; } catch {}
function applyTheme() {
  if (!THEMES.some(([key]) => key === theme)) theme = 'dark';
  document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  $('theme').textContent = THEMES.find(([key]) => key === theme)[1];
}
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.findIndex(([key]) => key === theme) + 1) % THEMES.length][0];
  try { localStorage.setItem('collab-atlas-theme', theme); } catch {}
  applyTheme();
});
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!theme) applyTheme(); });

async function loadData() {
  try {
    const response = await fetch('data/dashboard.json');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } catch {
    $('load-error').hidden = false;
    $('count').textContent = '데이터 로드 실패';
    $('updated').textContent = '데이터 연결을 확인해 주세요.';
    $('retry').addEventListener('click', () => location.reload());
    return null;
  }
}
const data = await loadData();
if (data) {

const gameName = new Map(data.games.map(game => [game.id, game.name]));
const gameThumb = new Map(data.games.map(game => [game.id, game.thumb]));
const formColor = form => `var(--form-${data.forms.indexOf(form) + 1})`;
// 필터, 차트, 목록에서 같은 이모지와 형태 이름을 사용한다.
const FORM_EMOJI = { '인게임': '🎮', '식음료': '🍔', '카페·팝업': '☕', '굿즈·하드웨어': '🎧', '브랜드': '🏷️', '음악': '🎵', '기타': '📌' };
const formEmoji = form => FORM_EMOJI[form] ?? '📌';
const glyph = form => '<span class="glyph" aria-hidden="true">' + formEmoji(form) + '</span>';
// form이 null이면 전체 형태를 보여준다. 칩은 한 번에 하나만 선택된다.
const filter = { game: 'all', year: 'all', region: 'all', search: '', form: null, partner: null, compare: new Set() };
const SORTS = ['newest', 'oldest', 'game'];

// ── 필터 ──
function options(select, entries) {
  select.innerHTML = entries.map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`).join('');
}
function countBy(list, keys) {
  const counts = new Map();
  for (const item of list) for (const key of [keys(item)].flat()) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}
options($('f-game'), [['all', '전체 게임'], ...data.games.filter(game => data.collabs.some(c => c.game === game.id)).map(game => [game.id, game.name])]);
options($('f-year'), [['all', '전체 연도'], ...[...new Set(data.collabs.map(c => c.date.slice(0, 4)))].sort().reverse().map(year => [year, `${year}년`])]);
options($('f-region'), [['all', '전체 지역'], ...[...countBy(data.collabs, c => c.regions)].sort((a, b) => b[1] - a[1]).map(([region]) => [region, region])]);
for (const [key, id] of [['game', 'f-game'], ['year', 'f-year'], ['region', 'f-region']]) {
  $(id).addEventListener('change', event => { filter[key] = event.target.value; render(); });
}
$('f-search').addEventListener('input', event => { filter.search = event.target.value.trim().toLowerCase(); render(); });
$('f-forms').innerHTML = [
  '<button type="button" class="chip" aria-pressed="true" data-form="">전체</button>',
  ...data.forms.map(form => `<button type="button" class="chip" aria-pressed="false" data-form="${esc(form)}">${glyph(form)}${esc(form)}</button>`),
].join('');
$('f-forms').addEventListener('click', event => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  // 같은 칩을 다시 누르면 전체로 돌아온다.
  filter.form = chip.dataset.form && chip.dataset.form !== filter.form ? chip.dataset.form : null;
  for (const button of $('f-forms').children) button.setAttribute('aria-pressed', (button.dataset.form || null) === filter.form);
  render();
});

// skip로 일부 필터를 건너뛴다. 비교는 게임 필터를, 파트너 순위는 파트너 필터를 무시해야 의미가 있다.
function filtered(skip = {}) {
  return data.collabs.filter(c =>
    (skip.game || filter.game === 'all' || c.game === filter.game) &&
    (skip.partner || !filter.partner || c.ip === filter.partner) &&
    (filter.year === 'all' || c.date.startsWith(filter.year)) &&
    (filter.region === 'all' || c.regions.includes(filter.region)) &&
    (!filter.form || c.form === filter.form) &&
    (!filter.search || [c.partner, c.note, c.campaign?.name, gameName.get(c.game)].join(' ').toLowerCase().includes(filter.search)));
}

// ── 타임라인 ──
const SVG = 'http://www.w3.org/2000/svg';
function el(name, attrs = {}, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  parent?.appendChild(node);
  return node;
}
function renderTimeline(list) {
  const box = $('timeline');
  const axis = $('timeline-axis');
  box.innerHTML = '';
  axis.innerHTML = '';
  const forms = data.forms.filter(form => list.some(c => c.form === form));
  $('legend').innerHTML = forms.map(form => `<span>${glyph(form)}${esc(form)}</span>`).join('');
  const width = Math.max(1120, box.clientWidth);
  const labelWidth = width < 760 ? 118 : 150;
  const top = 8;
  const axisHeight = 30;
  if (!list.length) {
    const svg = el('svg', { width, height: 80, viewBox: `0 0 ${width} 80` }, box);
    el('text', { x: width / 2, y: 44, 'text-anchor': 'middle', class: 'empty' }, svg).textContent = '조건에 맞는 콜라보가 없습니다';
    return;
  }

  const dates = list.map(c => c.date); // 선택한 기간 밖의 오늘 날짜로 축이 늘어나지 않는다.
  const min = new Date(dates.reduce((a, b) => a < b ? a : b));
  const max = new Date(dates.reduce((a, b) => a > b ? a : b));
  const start = new Date(min.getFullYear(), Math.floor(min.getMonth() / 3) * 3, 1);
  const end = new Date(max.getFullYear(), Math.floor(max.getMonth() / 3) * 3 + 3, 1);
  const x = date => labelWidth + (time(date) - start) / (end - start) * (width - labelWidth - 12);

  // 게임마다 한 줄씩. 날짜가 붙어 있는 콜라보는 점이 겹치지 않게 아래로 한 칸씩 쌓는다.
  const rowHeight = 22;
  const lanePad = 12;
  let y = top;
  const lanes = data.games.map(g => g.id).filter(id => list.some(c => c.game === id)).map(game => {
    const items = list.filter(c => c.game === game).slice().sort((a, b) => a.date.localeCompare(b.date));
    const lastX = [];
    const placed = items.map(c => {
      const at = x(c.date);
      let level = lastX.findIndex(previous => at - previous >= 22);
      if (level < 0) level = lastX.length;
      lastX[level] = at;
      return { collab: c, at, level };
    });
    const lane = { game, placed, top: y, height: lastX.length * rowHeight + lanePad * 2 };
    y += lane.height;
    return lane;
  });
  const bottom = y;
  const height = bottom + 22;

  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'group', 'aria-label': '게임별 콜라보 타임라인' }, box);
  // 연도 눈금은 세로 스크롤 중에도 보이도록 별도 SVG(sticky)에 그린다. 가로 스크롤은 아래 이벤트로 맞춘다.
  const axisSvg = el('svg', { width, height: axisHeight, viewBox: `0 0 ${width} ${axisHeight}`, 'aria-hidden': 'true' }, axis);
  axis.scrollLeft = box.scrollLeft;
  const years = end.getFullYear() - start.getFullYear();
  for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 3)) {
    if (years > 4 && d.getMonth() !== 0 && +d !== +start) continue;
    const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const tick = el('g', { class: 'tick' }, svg);
    el('line', { x1: x(at), x2: x(at), y1: 0, y2: bottom }, tick);
    if (x(at) + 34 < width) el('text', { x: x(at) + 3, y: axisHeight - 12 }, el('g', { class: 'tick' }, axisSvg)).textContent = (+d === +start || d.getMonth() === 0) ? `${d.getFullYear()}` : `${d.getMonth() + 1}월`;
  }

  lanes.forEach((lane, index) => {
    const group = el('g', { class: 'lane' }, svg);
    // 게임이 여러 개일 때 줄을 구분하기 쉽도록 한 줄 건너 배경을 깐다.
    if (index % 2) el('rect', { class: 'lane-band', x: 0, y: lane.top, width, height: lane.height }, group);
    if (lane.top > top) el('line', { class: 'lane-split', x1: 0, x2: width, y1: lane.top, y2: lane.top }, group);
    // 라벨 왼쪽 썸네일. 이미지가 없으면 빈 테두리 타일만 남는다.
    const thumbSize = 28;
    const thumbX = 4;
    const thumbY = lane.top + lane.height / 2 - thumbSize / 2;
    el('rect', { class: 'lane-thumb', x: thumbX, y: thumbY, width: thumbSize, height: thumbSize, rx: 5 }, group);
    if (gameThumb.get(lane.game)) {
      const clip = el('clipPath', { id: `thumb-clip-${index}` }, group);
      el('rect', { x: thumbX, y: thumbY, width: thumbSize, height: thumbSize, rx: 5 }, clip);
      const image = el('image', { href: gameThumb.get(lane.game), x: thumbX, y: thumbY, width: thumbSize, height: thumbSize, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#thumb-clip-${index})`, 'aria-hidden': 'true' }, group);
      image.addEventListener('error', () => image.remove(), { once: true });
    }
    const textX = thumbX + thumbSize + 8;
    const label = el('text', { x: textX, y: lane.top + lane.height / 2 - 2, class: 'lane-label' }, group);
    label.textContent = gameName.get(lane.game) ?? lane.game;
    for (let text = label.textContent; label.getComputedTextLength() > labelWidth - textX - 8 && text.length > 1;) {
      text = text.slice(0, -1);
      label.textContent = text.trimEnd() + '…';
    }
    el('text', { x: textX, y: lane.top + lane.height / 2 + 14, class: 'lane-count' }, group).textContent = `${lane.placed.length}건`;
    for (const { collab, at, level } of lane.placed) {
      const cy = lane.top + lanePad + level * rowHeight + rowHeight / 2;
      const mark = el('g', { class: 'mark', tabindex: 0, 'data-id': collab.id, role: 'button',
        'aria-label': `${dotted(collab.date)} ${collab.partner} ${collab.form}` }, group);
      el('circle', { class: 'mark-hit', cx: at, cy, r: 12 }, mark);
      el('text', { class: 'mark-emoji', x: at, y: cy, dy: '0.35em', 'text-anchor': 'middle', 'aria-hidden': 'true' }, mark).textContent = formEmoji(collab.form);
    }
  });

  if (today >= iso(start) && today <= iso(end)) {
    const marker = el('g', { class: 'today' }, svg);
    el('line', { x1: x(today), x2: x(today), y1: 0, y2: bottom + 4 }, marker);
    // 위쪽은 눈금 라벨 자리라 겹치지 않도록 아래에 적는다.
    el('text', { x: x(today), y: bottom + 17, 'text-anchor': 'middle' }, marker).textContent = '오늘';
  }
}
$('timeline').addEventListener('scroll', () => { $('timeline-axis').scrollLeft = $('timeline').scrollLeft; });
const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// ── 툴팁과 목록 이동 ──
const tooltip = $('tooltip');
const byId = new Map(data.collabs.map(c => [c.id, c]));
function showTooltip(c, clientX, clientY) {
  tooltip.innerHTML = `<strong>${esc(gameName.get(c.game))} × ${esc(c.partner)}</strong>
    <div>${esc(dotted(c.date))} · ${esc(c.form)} · ${esc(c.regions.join(', '))}</div>
    ${c.campaign ? `<div>캠페인 ${esc(c.campaign.name)}</div>` : ''}`;
  tooltip.hidden = false;
  const { width, height } = tooltip.getBoundingClientRect();
  tooltip.style.left = `${Math.max(8, Math.min(clientX + 14, innerWidth - width - 8))}px`;
  tooltip.style.top = `${clientY + 14 + height > innerHeight ? clientY - height - 10 : clientY + 14}px`;
}
$('timeline').addEventListener('pointermove', event => {
  const mark = event.target.closest('.mark');
  if (mark) showTooltip(byId.get(mark.dataset.id), event.clientX, event.clientY);
  else tooltip.hidden = true;
});
$('timeline').addEventListener('pointerleave', () => { tooltip.hidden = true; });
$('timeline').addEventListener('focusin', event => {
  const mark = event.target.closest('.mark');
  if (!mark) return;
  const rect = mark.getBoundingClientRect();
  showTooltip(byId.get(mark.dataset.id), rect.left + rect.width / 2, rect.bottom - 4);
});
$('timeline').addEventListener('focusout', () => { tooltip.hidden = true; });
function jump(id) {
  const card = document.getElementById(`c-${id}`);
  if (!card) return;
  tooltip.hidden = true;
  card.focus({ preventScroll: true });
  card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1600);
}
$('timeline').addEventListener('click', event => { const mark = event.target.closest('.mark'); if (mark) jump(mark.dataset.id); });
$('timeline').addEventListener('keydown', event => {
  const mark = event.target.closest('.mark');
  if (mark && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); jump(mark.dataset.id); }
});

// ── 분석 막대 ──
// byForm이면 막대 색과 모양을 형태별 색·모양에 맞춘다.
function renderBars(target, entries, byForm) {
  const max = Math.max(1, ...entries.map(([, value]) => value));
  $(target).innerHTML = entries.length ? entries.map(([label, value]) => {
    const color = byForm ? formColor(label) : '';
    return `<div class="bar" title="${esc(label)} ${value}건">
      <span class="bar__label">${byForm ? glyph(label) : ''}${esc(label)}</span>
      <span class="bar__track"><span class="bar__fill" style="display:block;width:${value / max * 100}%;${color ? `--c:${color}` : ''}"></span></span>
      <span class="bar__value">${value}</span></div>`;
  }).join('') : '<p class="empty-note">데이터 없음</p>';
}

// ── 콜라보 목록 ──
// 목록과 CSV가 같은 순서를 쓴다.
function sorted(list) {
  const sort = $('sort').value;
  return [...list].sort((a, b) => sort === 'oldest' ? a.date.localeCompare(b.date) : sort === 'game' ? gameName.get(a.game).localeCompare(gameName.get(b.game), 'ko') || b.date.localeCompare(a.date) : b.date.localeCompare(a.date));
}
function renderList(list) {
  const ordered = sorted(list);
  $('list-count').textContent = list.length + '건';
  $('list').innerHTML = ordered.map(c => {
    const items = c.articles.map(article => {
      const label = LOCALES.find(([locale]) => locale === article.locale)?.[1] ?? article.locale;
      const url = /^https?:\/\//i.test(article.url) ? article.url : '#';
      return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(c.partner)} ${esc(label)} 공지, 새 탭">${esc(label)} 공지 <span class="notice-date">${esc(dotted(article.date).slice(2))}</span></a>`;
    });
    const links = items.length > 1
      ? `<details class="notices"><summary>공지 ${items.length}건</summary><div class="notices__list">${items.join('')}</div></details>`
      : `<div class="notices__list">${items.join('') || '<span>공지 없음</span>'}</div>`;
    return `<article class="item" id="c-${esc(c.id)}" tabindex="-1" aria-label="${esc(gameName.get(c.game))}, ${esc(c.partner)}">
      <div class="item__identity"><h3><span class="item__game">${esc(gameName.get(c.game))}</span>${esc(c.partner)}</h3>
      ${c.campaign ? '<span class="tag">' + esc(c.campaign.name) + '</span>' : ''}
      ${c.note ? '<p class="item__note">' + esc(c.note) + '</p>' : ''}</div>
      <div class="item__form">${glyph(c.form)}${esc(c.form)}</div>
      <div class="item__meta">${esc(c.regions.join(', '))}</div>
      <time class="item__date" datetime="${esc(c.date)}">${esc(dotted(c.date))}</time>
      <div class="item__links">${links}</div></article>`;
  }).join('') || '<div class="empty-state"><strong>검색 결과가 없습니다</strong><p>검색어나 필터 조건을 바꿔 보세요.</p><button type="button" id="empty-reset">필터 초기화</button></div>';
  $('empty-reset')?.addEventListener('click', () => { resetFilters(); $('f-search').focus(); });
}
$('sort').addEventListener('change', () => { renderList(filtered()); writeUrl(); });

// 필터 상태를 화면 컨트롤에 반영한다. 초기화와 주소 복원이 함께 쓴다.
function syncControls() {
  $('f-game').value = filter.game;
  $('f-year').value = filter.year;
  $('f-region').value = filter.region;
  $('f-search').value = filter.search;
  for (const button of $('f-forms').children) button.setAttribute('aria-pressed', (button.dataset.form || null) === filter.form);
  const partnerName = filter.partner && data.collabs.find(c => c.ip === filter.partner)?.partner;
  $('f-partner').hidden = !partnerName;
  if (partnerName) {
    $('f-partner-btn').textContent = `${partnerName} ✕`;
    $('f-partner-btn').setAttribute('aria-label', `파트너 필터 해제: ${partnerName}`);
  }
}
function resetFilters() {
  Object.assign(filter, { game: 'all', year: 'all', region: 'all', search: '', form: null, partner: null });
  syncControls();
  render();
}
$('f-reset').addEventListener('click', resetFilters);

function render() {
  const list = filtered();
  const active = filter.game !== 'all' || filter.year !== 'all' || filter.region !== 'all' || filter.search || filter.form || filter.partner;
  $('f-reset').disabled = !active;
  $('count').textContent = active ? `${list.length}건 / 전체 ${data.collabs.length}건` : `${list.length}건`;
  renderTimeline(list);
  renderBars('by-form', [...countBy(list, c => c.form)].sort((a, b) => b[1] - a[1]), true);
  renderBars('by-region', [...countBy(list, c => c.regions)].sort((a, b) => b[1] - a[1]));
  renderBars('by-year', [...countBy(list, c => `${c.date.slice(0, 4)}년`)].sort((a, b) => a[0].localeCompare(b[0])));
  renderList(list);
  renderNotes(list);
  renderCompare();
  renderPartners();
  writeUrl();
}


// ── 게임 비교 ──
const pct = (value, total) => total ? Math.round(value / total * 100) : 0;
const TABLE_LIMIT = { shared: 8, partners: 10 };
const expanded = { shared: false, partners: false };
const sumEntries = maps => { const total = new Map(); for (const map of maps) for (const [key, value] of map) total.set(key, (total.get(key) || 0) + value); return total; };

$('cmp-games').innerHTML = data.games.filter(game => data.collabs.some(c => c.game === game.id))
  .map(game => `<button type="button" class="chip" aria-pressed="false" data-game="${esc(game.id)}">${esc(game.name)}</button>`).join('');
$('cmp-games').addEventListener('click', event => {
  const chip = event.target.closest('.chip');
  if (!chip) return;
  if (filter.compare.has(chip.dataset.game)) filter.compare.delete(chip.dataset.game); else filter.compare.add(chip.dataset.game);
  renderCompare();
  writeUrl();
});

function renderCompare() {
  for (const chip of $('cmp-games').children) chip.setAttribute('aria-pressed', filter.compare.has(chip.dataset.game));
  const base = filtered({ game: true });
  const withData = data.games.filter(game => base.some(c => c.game === game.id));
  const picked = filter.compare.size ? withData.filter(game => filter.compare.has(game.id)) : withData;
  const table = $('cmp-table');
  if (!picked.length) {
    table.innerHTML = '<tbody><tr><td class="empty-note">조건에 맞는 콜라보가 없습니다</td></tr></tbody>';
    $('shared-table').innerHTML = '';
    $('shared-count').textContent = '';
    $('shared-more').hidden = true;
    return;
  }
  const cols = picked.map(game => {
    const items = base.filter(c => c.game === game.id);
    const partners = countBy(items, c => c.ip);
    const top = [...partners].sort((a, b) => b[1] - a[1])[0];
    return {
      game, total: items.length,
      form: countBy(items, c => c.form), region: countBy(items, c => c.regions), year: countBy(items, c => c.date.slice(0, 4)),
      unique: partners.size, repeat: [...partners.values()].filter(n => n > 1).length,
      top: top && top[1] > 1 ? `${items.find(c => c.ip === top[0]).partner} ${top[1]}회` : '',
    };
  });
  const cell = (col, map, key, color) => {
    const value = map.get(key) || 0;
    if (!value) return '<td><span class="cmp__none">–</span></td>';
    return `<td><span class="cmp__cell"><span class="cmp__v">${value}건<small>${pct(value, col.total)}%</small></span><span class="cmp__bar"><i style="width:${pct(value, col.total)}%;${color ? `--c:${color}` : ''}"></i></span></span></td>`;
  };
  const group = label => `<tr class="cmp__group"><th scope="rowgroup" colspan="${cols.length + 1}">${label}</th></tr>`;
  const row = (label, cells) => `<tr><th scope="row">${label}</th>${cells}</tr>`;
  const regions = [...sumEntries(cols.map(c => c.region))].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([region]) => region);
  const years = [...sumEntries(cols.map(c => c.year)).keys()].sort();
  const forms = data.forms.filter(form => cols.some(c => c.form.has(form)));
  table.innerHTML = `<caption class="sr-only">게임별 콜라보 구성 비교</caption>
    <thead><tr><th scope="col">${picked.length}개 게임</th>${cols.map(col => `<th scope="col">${esc(col.game.name)}</th>`).join('')}</tr></thead>
    <tbody>
      ${row('콜라보 건수', cols.map(col => `<td><strong class="cmp__total">${col.total}건</strong></td>`).join(''))}
      ${group('형태')}
      ${forms.map(form => row(`${glyph(form)}${esc(form)}`, cols.map(col => cell(col, col.form, form, formColor(form))).join(''))).join('')}
      ${group('진행 지역')}
      ${regions.map(region => row(esc(region), cols.map(col => cell(col, col.region, region)).join(''))).join('')}
      ${group('연도')}
      ${years.map(year => row(`${year}년`, cols.map(col => cell(col, col.year, year)).join(''))).join('')}
      ${group('파트너')}
      ${row('파트너 수', cols.map(col => `<td>${col.unique}곳</td>`).join(''))}
      ${row('2회 이상 반복', cols.map(col => `<td>${col.repeat}곳${col.unique ? `<small class="cmp__sub">${pct(col.repeat, col.unique)}%</small>` : ''}</td>`).join(''))}
      ${row('가장 많이 한 파트너', cols.map(col => `<td>${col.top ? esc(col.top) : '<span class="cmp__none">–</span>'}</td>`).join(''))}
    </tbody>`;

  // 둘 이상의 게임이 쓴 파트너. 비교 대상으로 고른 게임 안에서만 센다.
  const byPartner = new Map();
  for (const c of base.filter(item => picked.some(game => game.id === item.game))) {
    const entry = byPartner.get(c.ip) ?? { ip: c.ip, name: c.partner, category: c.partner_category, games: new Map(), total: 0 };
    entry.games.set(c.game, (entry.games.get(c.game) || 0) + 1);
    entry.total++;
    byPartner.set(c.ip, entry);
  }
  const shared = [...byPartner.values()].filter(entry => entry.games.size > 1)
    .sort((a, b) => b.games.size - a.games.size || b.total - a.total || a.name.localeCompare(b.name, 'ko'));
  $('shared-count').textContent = shared.length ? `${shared.length}곳` : '';
  const shown = expanded.shared ? shared : shared.slice(0, TABLE_LIMIT.shared);
  $('shared-table').innerHTML = shared.length
    ? `<caption class="sr-only">두 게임 이상이 함께 쓴 파트너</caption>
       <thead><tr><th scope="col">파트너</th><th scope="col">분류</th><th scope="col">사용한 게임</th><th scope="col" class="num">합계</th></tr></thead>
       <tbody>${shown.map(entry => `<tr><th scope="row"><button type="button" class="link-btn" data-partner="${esc(entry.ip)}">${esc(entry.name)}</button></th>
         <td>${esc(entry.category || '미분류')}</td>
         <td>${[...entry.games].map(([game, n]) => `<span class="game-count">${esc(gameName.get(game))} ${n}</span>`).join('')}</td>
         <td class="num">${entry.total}건</td></tr>`).join('')}</tbody>`
    : `<tbody><tr><td class="empty-note">${picked.length < 2 ? '게임을 2개 이상 비교할 때 공통 파트너를 보여 줍니다.' : '선택한 게임이 함께 쓴 파트너가 없습니다.'}</td></tr></tbody>`;
  moreButton('shared-more', 'shared', shared.length);
}
function moreButton(id, key, total) {
  const button = $(id);
  button.hidden = total <= TABLE_LIMIT[key];
  button.textContent = expanded[key] ? '상위만 보기' : `전체 ${total}곳 보기`;
  button.setAttribute('aria-expanded', expanded[key]);
}
for (const [id, key] of [['shared-more', 'shared'], ['partner-more', 'partners']]) {
  $(id).addEventListener('click', () => { expanded[key] = !expanded[key]; renderCompare(); renderPartners(); });
}

// ── 파트너 분석 ──
function renderPartners() {
  // 파트너 필터를 무시해야 순위가 한 곳으로 줄어들지 않는다.
  const base = filtered({ partner: true });
  const byPartner = new Map();
  for (const c of base) {
    const entry = byPartner.get(c.ip) ?? { ip: c.ip, name: c.partner, category: c.partner_category, items: [] };
    entry.items.push(c);
    byPartner.set(c.ip, entry);
  }
  const ranked = [...byPartner.values()].sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name, 'ko'));
  const repeat = ranked.filter(entry => entry.items.length > 1).length;
  $('partner-summary').innerHTML = ranked.length
    ? `파트너 <strong>${ranked.length}곳</strong> 중 2회 이상 한 곳은 <strong>${repeat}곳</strong>(${pct(repeat, ranked.length)}%)입니다.`
    : '';
  const max = Math.max(1, ...ranked.map(entry => entry.items.length));
  const shown = expanded.partners ? ranked : ranked.slice(0, TABLE_LIMIT.partners);
  $('partner-table').innerHTML = ranked.length
    ? `<caption class="sr-only">파트너별 콜라보 횟수 순위</caption>
       <thead><tr><th scope="col" class="num">순위</th><th scope="col">파트너</th><th scope="col">분류</th><th scope="col">콜라보</th><th scope="col">게임</th><th scope="col" class="num">기간</th></tr></thead>
       <tbody>${shown.map(entry => {
         const games = [...new Set(entry.items.map(c => gameName.get(c.game)))];
         const years = entry.items.map(c => c.date.slice(0, 4)).sort();
         const span = years[0] === years.at(-1) ? years[0] : `${years[0]}–${years.at(-1)}`;
         return `<tr${entry.ip === filter.partner ? ' class="is-active"' : ''}><td class="num">${ranked.indexOf(entry) + 1}</td>
           <th scope="row"><button type="button" class="link-btn" data-partner="${esc(entry.ip)}">${esc(entry.name)}</button></th>
           <td>${esc(entry.category || '미분류')}</td>
           <td><span class="cmp__cell"><span class="cmp__v">${entry.items.length}건</span><span class="cmp__bar"><i style="width:${entry.items.length / max * 100}%"></i></span></span></td>
           <td>${esc(games.length > 2 ? `${games[0]} 외 ${games.length - 1}` : games.join(', '))}</td>
           <td class="num">${span}</td></tr>`;
       }).join('')}</tbody>`
    : '<tbody><tr><td class="empty-note">조건에 맞는 파트너가 없습니다</td></tr></tbody>';
  moreButton('partner-more', 'partners', ranked.length);
  renderBars('by-pcat', [...countBy(base, c => c.partner_category || '미분류')].sort((a, b) => b[1] - a[1]));
}
function setPartner(ip) {
  filter.partner = filter.partner === ip ? null : ip;
  syncControls();
  render();
  if (filter.partner) $('list-section').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-partner]');
  if (button) setPartner(button.dataset.partner);
});
$('f-partner-btn').addEventListener('click', () => { filter.partner = null; syncControls(); render(); });

// ── 내보내기와 공유 링크 ──
const STATE_KEYS = { game: 'game', year: 'year', region: 'region', form: 'form', partner: 'partner', search: 'q' };
function writeUrl() {
  const params = new URLSearchParams();
  for (const [key, name] of Object.entries(STATE_KEYS)) {
    const value = filter[key];
    if (value && value !== 'all') params.set(name, value);
  }
  if ($('sort').value !== 'newest') params.set('sort', $('sort').value);
  if (filter.compare.size) params.set('cmp', [...filter.compare].join(','));
  const query = params.toString();
  history.replaceState(null, '', location.pathname + (query ? `?${query}` : '') + location.hash);
}
function readUrl() {
  const params = new URLSearchParams(location.search);
  const known = (name, valid) => { const value = params.get(name); return value && valid(value) ? value : null; };
  filter.game = known('game', value => data.collabs.some(c => c.game === value)) ?? 'all';
  filter.year = known('year', value => data.collabs.some(c => c.date.startsWith(value))) ?? 'all';
  filter.region = known('region', value => data.collabs.some(c => c.regions.includes(value))) ?? 'all';
  filter.form = known('form', value => data.forms.includes(value));
  filter.partner = known('partner', value => data.collabs.some(c => c.ip === value));
  filter.search = (params.get('q') ?? '').trim().toLowerCase();
  const sort = known('sort', value => SORTS.includes(value));
  if (sort) $('sort').value = sort;
  filter.compare = new Set((params.get('cmp') ?? '').split(',').filter(id => data.collabs.some(c => c.game === id)));
}

let statusTimer;
function say(message) {
  $('tool-status').textContent = message;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { $('tool-status').textContent = ''; }, 3000);
}
// 엑셀이 글 내용을 수식으로 읽지 않도록 =, +, @, -로 시작하는 칸 앞에 따옴표를 붙인다.
const csvCell = value => {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};
$('export-csv').addEventListener('click', () => {
  const list = sorted(filtered());
  if (!list.length) return say('내려받을 콜라보가 없습니다');
  const header = ['게임', '파트너', '파트너 분류', '형태', '진행 지역', '날짜', '캠페인', '메모', '공지'];
  const rows = list.map(c => [
    gameName.get(c.game), c.partner, c.partner_category, c.form, c.regions.join(', '), c.date, c.campaign?.name ?? '', c.note ?? '',
    c.articles.map(article => `${LOCALES.find(([locale]) => locale === article.locale)?.[1] ?? article.locale} ${article.url}`).join('\n'),
  ]);
  // 엑셀이 한글을 깨뜨리지 않도록 BOM을 붙인다.
  const blob = new Blob(['﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `collab-atlas-${today.replaceAll('-', '')}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  say(`${list.length}건을 내려받았습니다`);
});
$('copy-link').addEventListener('click', async () => {
  writeUrl();
  try { await navigator.clipboard.writeText(location.href); say('현재 필터가 담긴 링크를 복사했습니다'); }
  catch {
    const field = Object.assign(document.createElement('textarea'), { value: location.href });
    document.body.append(field);
    field.select();
    const ok = document.execCommand?.('copy');
    field.remove();
    say(ok ? '현재 필터가 담긴 링크를 복사했습니다' : '복사하지 못했습니다. 주소창의 링크를 사용해 주세요');
  }
});

// 게임별 성향 요약. 게임을 고르면 해당 게임만 남긴다.
function renderNotes(list) {
  const counts = countBy(list, c => c.game);
  const notes = data.games.filter(game => game.summary && counts.get(game.id));
  $('notes-section').hidden = !notes.length;
  $('notes').innerHTML = notes.map(game => `
    <article class="note">
      <span class="note__thumb" aria-hidden="true">${esc(game.name.charAt(0))}${game.thumb ? `<img src="${esc(game.thumb)}" alt="" loading="lazy">` : ''}</span>
      <div class="note__body">
        <h3>${esc(game.name)} <span class="note__count">${counts.get(game.id)}건</span></h3>
        ${game.publisher ? `<p class="note__publisher">${esc(game.publisher)}</p>` : ''}
        <p>${esc(game.summary)}</p>
      </div>
    </article>`).join('');
  // 이미지가 없으면 img를 지워 첫 글자 타일이 보이게 한다.
  $('notes').querySelectorAll('.note__thumb img').forEach(img => img.addEventListener('error', () => img.remove(), { once: true }));
}

// 전체 데이터 규모와 갱신일을 표시한다.
$('updated').innerHTML = [
  ['게임', data.games.length + '개'],
  ['콜라보', data.collabs.length + '건'],
  ['파트너', new Set(data.collabs.map(c => c.ip)).size + '곳'],
  ['갱신', dotted(data.generated.slice(0, 10))]
].map(([label,value]) => '<span class="summary__item"><span>' + label + '</span><strong>' + esc(value) + '</strong></span>').join('');
readUrl();
syncControls();
render();
// 타임라인은 SVG 폭을 픽셀로 정하므로, 영역 폭이 바뀌면 다시 그린다. 탭이 숨겨진 동안 바뀐 경우도 있어 여러 신호를 함께 본다.
function fitTimeline() {
  const box = $('timeline');
  const drawn = Number(box.querySelector('svg')?.getAttribute('width'));
  if (box.clientWidth && Math.abs(Math.max(1120, box.clientWidth) - drawn) > 8) renderTimeline(filtered());
}
new ResizeObserver(fitTimeline).observe($('timeline').parentElement);
addEventListener('resize', fitTimeline);
document.addEventListener('visibilitychange', fitTimeline);

// 메뉴 상태는 실제 화면에 보이는 구역을 따라간다.
const navLinks = [...document.querySelectorAll('.section-nav a')];
const sections = navLinks.map(link => document.querySelector(link.getAttribute('href')));
function updateNav() {
  let current = sections[0];
  for (const section of sections) if (section.getBoundingClientRect().top <= 150 + (parseFloat(document.documentElement.style.getPropertyValue('--sticky-offset')) || 0)) current = section;
  for (const link of navLinks) {
    if (link.hash === '#' + current.id) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
}
addEventListener('scroll', updateNav, { passive: true });
updateNav();
}




function focusSearch() { $('f-search').focus({preventScroll:true}); $('search-section').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'}); }
$('search-shortcut').addEventListener('click',focusSearch);
addEventListener('keydown',event=>{ if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();focusSearch();} });
function updateHeader(){document.querySelector('.top').classList.toggle('is-scrolled',scrollY>24);}
addEventListener('scroll',updateHeader,{passive:true});updateHeader();

// 고정된 필터 높이만큼 구역 이동 여백을 늘린다. 모바일에서는 고정하지 않으므로 0이다.
function syncStickyOffset(){const filters=$('search-section');const sticky=getComputedStyle(filters).position==='sticky';document.documentElement.style.setProperty('--sticky-offset',(sticky?filters.offsetHeight:0)+'px');}
new ResizeObserver(syncStickyOffset).observe($('search-section'));matchMedia('(min-width:768px)').addEventListener('change',syncStickyOffset);syncStickyOffset();
