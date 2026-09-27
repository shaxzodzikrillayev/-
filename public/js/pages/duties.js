/** Список дежурств: фильтры по периоду, статусу, команде и поиску. */
import { el, dateLabel, todayStr, debounce, plural } from '../lib/dom.js';
import { dutiesApi } from '../lib/api.js';
import { state, can, canAny, teamById } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import {
  statusBadge, markBadge, teamChip, empty, segment, badge, avatar, toast, err, ok,
  confirmDialog, modal, field, withBusy, MARK_META,
} from '../lib/ui.js';

const SCOPES = [
  { value: 'all', label: 'Все' },
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'next_week', label: 'След. неделя' },
  { value: 'upcoming', label: 'Будущие' },
  { value: 'past', label: 'Прошлые' },
];

const STATUSES = [
  { value: '', label: 'Любой статус' },
  { value: 'planned', label: 'Запланировано' },
  { value: 'pending', label: 'Ожидает проверки' },
  { value: 'done', label: 'Выполнено' },
  { value: 'missed', label: 'Не выполнено' },
];

function dutyRow(d) {
  const mine = d.myMark && d.myMark !== 'unmarked';
  return el(`.duty-card${d.isToday ? '.is-today' : ''}`, {
    style: { '--team-color': d.teamColor ?? '#6366f1' },
    role: 'button', tabindex: 0,
    onclick: () => navigate(`/duties/${d.id}`),
    onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(`/duties/${d.id}`); } },
  },
  el('.duty-date', {},
    el('span.d', {}, d.isToday ? '•' : d.date.slice(8, 10)),
    el('span.m', {}, d.isToday ? 'сегодня' : `${d.date.slice(8, 10)}.${d.date.slice(5, 7)}`),
  ),
  el('div.grow', { style: { minWidth: 0 } },
    el('.row-between.gap-1', {},
      el('div', { style: { minWidth: 0 } },
        teamChip(d, { clickable: false }),
        el('.text-sm.text-mute.mt-0.truncate', {}, dateLabel(d.date)),
      ),
      el('.row.row-actions', {},
        d.photoCount ? el('span.text-xs.text-mute.nowrap', {}, `📷 ${d.photoCount}`) : null,
        mine ? markBadge(d.myMark) : statusBadge(d.status),
      ),
    ),
    el('.text-xs.text-soft.truncate', { style: { marginTop: '2px' } },
      `${d.dutyTime ?? ''}${d.responsible ? ` · ${d.responsible.shortName ?? d.responsible.fullName}` : ''}`),
  ),
  '›',
  );
}

export async function dutiesPage(ctx) {
  const q = ctx.query;
  const filters = {
    scope: q.scope ?? 'all',
    status: q.status ?? '',
    teamId: q.teamId ?? '',
    q: q.q ?? '',
  };

  const listBox = el('.grid', { style: { gap: '10px' } });
  const countBox = el('p.text-sm.text-mute');

  const search = el('input.input.input-icon', {
    type: 'search', placeholder: 'Поиск по команде или фамилии…', value: filters.q,
    oninput: debounce(() => { filters.q = search.value.trim(); load(); }, 350),
  }, el('span.input-icon', {}, '🔍'));

  const statusSel = el('select.select', {
    onchange: () => { filters.status = statusSel.value; load(); },
  }, STATUSES.map((s) => el('option', { value: s.value, selected: s.value === filters.status }, s.label)));

  const teamSel = el('select.select', {
    onchange: () => { filters.teamId = teamSel.value; load(); },
  },
  el('option', { value: '' }, 'Все команды'),
  state.teams.map((t) => el('option', { value: t.id, selected: String(t.id) === String(filters.teamId) }, `№${t.number} ${t.name.replace(/^Команда №\d+\s*—\s*/, '')}`)),
  );

  const scopeSeg = segment(SCOPES, filters.scope, (v) => { filters.scope = v; load(); });

  const applyUrl = () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && v !== 'all') params.set(k, v);
    const qs = params.toString();
    history.replaceState(null, '', `#/duties${qs ? `?${qs}` : ''}`);
  };

  async function load() {
    applyUrl();
    countBox.textContent = 'Загрузка…';
    listBox.replaceChildren(el('.loading-block', {}, el('.spinner'), el('span.text-mute', {}, 'Загружаем дежурства…')));
    const params = { scope: filters.scope };
    if (filters.status) params.status = filters.status;
    if (filters.teamId) params.teamId = filters.teamId;
    if (filters.q) params.q = filters.q;
    const { duties } = await dutiesApi.list(params);
    countBox.textContent = duties.length
      ? `${duties.length} ${plural(duties.length, 'дежурство', 'дежурства', 'дежурств')}`
      : 'Ничего не найдено';
    listBox.replaceChildren(...(duties.length
      ? duties.map(dutyRow)
      : [el('.card', {}, empty({
        icon: '🔍',
        title: 'Дежурств не найдено',
        text: 'Измените фильтры или создайте дежурство на сегодня.',
        action: can('duty.create') || can('duty.schedule') ? el('button.btn.btn-primary', { type: 'button', onclick: openCreate }, 'Создать дежурство') : null,
      }))]));
  }

  /* ─────────── создание дежурства ─────────── */
  async function openCreate() {
    const date = el('input.input', { type: 'date', name: 'date', required: true, value: todayStr() });
    const team = el('select.select', { name: 'teamId', required: true },
      el('option', { value: '' }, '— команда —'),
      state.teams.map((t) => el('option', { value: t.id }, t.name)));
    const time = el('input.input', { name: 'dutyTime', value: '08:00 – 08:20', required: true, maxlength: 60 });

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            const { duty } = await dutiesApi.create({
              date: date.value,
              teamId: team.value,
              dutyTime: time.value.trim(),
            });
            ok('Дежурство создано');
            m.close();
            navigate(`/duties/${duty.id}`);
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Дата', date, { required: true }),
    field('Команда', team, { required: true }),
    field('Время и место', time, { required: true, hint: 'Например: 08:00 – 08:20 · Главный зал' }),
    el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Создать'),
    );

    const m = modal({ title: 'Новое дежурство', body: form, size: 'sm' });
  }

  const head = el('.page-head', {},
    el('div', {},
      el('h1.page-title', {}, 'Дежурства'),
      countBox,
    ),
    el('.page-actions', {},
      canAny('duty.create', 'duty.schedule')
        ? el('button.btn.btn-primary', { type: 'button', onclick: openCreate }, '＋ Создать')
        : null,
    ),
  );

  const wrap = el('.page.page-enter', {},
    head,
    el('.card.card-pad', { style: { marginBottom: '16px' } },
      el('.row.row-wrap.gap-1', { style: { marginBottom: '12px' } }, scopeSeg),
      el('.grid.grid-auto-sm', {},
        el('div.grow', {}, search),
        statusSel,
        teamSel,
      ),
    ),
    listBox,
  );

  await load();
  return wrap;
}
