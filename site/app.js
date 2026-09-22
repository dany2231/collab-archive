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
const formColor = form => `var(--form-${data.forms.indexOf(form) + 1})`;
// 필터, 차트, 목록에서 같은 이모지와 형태 이름을 사용한다.
const FORM_EMOJI = { '인게임': '🎮', '식음료': '🍔', '카페·팝업': '☕', '굿즈·하드웨어': '🎧', '브랜드': '🏷️', '음악': '🎵', '기타': '📌' };
const formEmoji = form => FORM_EMOJI[form] ?? '📌';
const glyph = form => '<span class="glyph" aria-hidden="true">' + formEmoji(form) + '</span>';
// form이 null이면 전체 형태를 보여준다. 칩은 한 번에 하나만 선택된다.
const filter = { game: 'all', year: 'all', region: 'all', search: '', form: null };

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

function filtered() {
  return data.collabs.filter(c =>
    (filter.game === 'all' || c.game === filter.game) &&
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
  box.innerHTML = '';
  const forms = data.forms.filter(form => list.some(c => c.form === form));
  $('legend').innerHTML = forms.map(form => `<span>${glyph(form)}${esc(form)}</span>`).join('');
  const width = Math.max(1120, box.clientWidth);
  const labelWidth = width < 760 ? 118 : 150;
  const top = 30;
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
  const years = end.getFullYear() - start.getFullYear();
  for (let d = new Date(start); d <= end; d.setMonth(d.getMonth() + 3)) {
    if (years > 4 && d.getMonth() !== 0 && +d !== +start) continue;
    const at = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
    const tick = el('g', { class: 'tick' }, svg);
    el('line', { x1: x(at), x2: x(at), y1: top - 6, y2: bottom }, tick);
    if (x(at) + 34 < width) el('text', { x: x(at) + 3, y: top - 12 }, tick).textContent = (+d === +start || d.getMonth() === 0) ? `${d.getFullYear()}` : `${d.getMonth() + 1}월`;
  }

  lanes.forEach((lane, index) => {
    const group = el('g', { class: 'lane' }, svg);
    // 게임이 여러 개일 때 줄을 구분하기 쉽도록 한 줄 건너 배경을 깐다.
    if (index % 2) el('rect', { class: 'lane-band', x: 0, y: lane.top, width, height: lane.height }, group);
    if (lane.top > top) el('line', { class: 'lane-split', x1: 0, x2: width, y1: lane.top, y2: lane.top }, group);
    const label = el('text', { x: 4, y: lane.top + lane.height / 2, class: 'lane-label' }, group);
    label.textContent = gameName.get(lane.game) ?? lane.game;
    for (let text = label.textContent; label.getComputedTextLength() > labelWidth - 14 && text.length > 1;) {
      text = text.slice(0, -1);
      label.textContent = text.trimEnd() + '…';
    }
    el('text', { x: 4, y: lane.top + lane.height / 2 + 16, class: 'lane-count' }, group).textContent = `${lane.placed.length}건`;
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
    el('line', { x1: x(today), x2: x(today), y1: top - 6, y2: bottom + 4 }, marker);
    // 위쪽은 눈금 라벨 자리라 겹치지 않도록 아래에 적는다.
    el('text', { x: x(today), y: bottom + 17, 'text-anchor': 'middle' }, marker).textContent = '오늘';
  }
}
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
function renderList(list) {
  const sort = $('sort').value;
  const ordered = [...list].sort((a, b) => sort === 'oldest' ? a.date.localeCompare(b.date) : sort === 'game' ? gameName.get(a.game).localeCompare(gameName.get(b.game), 'ko') || b.date.localeCompare(a.date) : b.date.localeCompare(a.date));
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
$('sort').addEventListener('change', () => renderList(filtered()));

// 필터를 처음 상태로 되돌린다.
function resetFilters() {
  Object.assign(filter, { game: 'all', year: 'all', region: 'all', search: '', form: null });
  for (const id of ['f-game', 'f-year', 'f-region']) $(id).value = 'all';
  $('f-search').value = '';
  for (const button of $('f-forms').children) button.setAttribute('aria-pressed', !button.dataset.form);
  render();
}
$('f-reset').addEventListener('click', resetFilters);

function render() {
  const list = filtered();
  const active = filter.game !== 'all' || filter.year !== 'all' || filter.region !== 'all' || filter.search || filter.form;
  $('f-reset').disabled = !active;
  $('count').textContent = active ? `${list.length}건 / 전체 ${data.collabs.length}건` : `${list.length}건`;
  renderTimeline(list);
  renderBars('by-form', [...countBy(list, c => c.form)].sort((a, b) => b[1] - a[1]), true);
  renderBars('by-region', [...countBy(list, c => c.regions)].sort((a, b) => b[1] - a[1]));
  renderBars('by-year', [...countBy(list, c => `${c.date.slice(0, 4)}년`)].sort((a, b) => a[0].localeCompare(b[0])));
  renderList(list);
}

// 전체 데이터 규모와 갱신일을 표시한다.
$('updated').innerHTML = [
  ['게임', data.games.length + '개'],
  ['콜라보', data.collabs.length + '건'],
  ['파트너', new Set(data.collabs.map(c => c.ip)).size + '곳'],
  ['갱신', dotted(data.generated.slice(0, 10))]
].map(([label,value]) => '<span class="summary__item"><span>' + label + '</span><strong>' + esc(value) + '</strong></span>').join('');
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
  for (const section of sections) if (section.getBoundingClientRect().top <= 150) current = section;
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
