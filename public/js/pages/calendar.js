/** Календарь дежурств: сетка месяца с цветами команд и статусами. */
import { el, todayStr, dateToStr, parseDate, startOfWeek, addDays, MONTH_NAMES, weekdayShort } from '../lib/dom.js';
import { dutiesApi } from '../lib/api.js';
import { can, canAny, teamById, state } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import { STATUS_META, badge, empty, toast, err, ok, modal, field, withBusy, confirmDialog } from '../lib/ui.js';

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function calendarPage(ctx) {
  let month = ctx.query.month ?? todayStr().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) month = todayStr().slice(0, '7');

  const headBox = el('.page-head');
  const gridBox = el('.card.card-pad');
  const legend = el('.cal-legend', {},
    ...state.teams.map((t) => el('.cal-legend-item', {},
      el('span.team-dot', { style: { background: t.color } }),
      el('span', {}, `№${t.number}`),
    )),
    el('span.divider-v'),
    ...Object.entries(STATUS_META).map(([k, m]) => el('.cal-legend-item', {},
      el(`.dot.dot-${m.tone}`),
      el('span', {}, m.label),
    )),
  );

  async function load() {
    gridBox.replaceChildren(el('.loading-block', {}, el('.spinner'), el('span.text-mute', {}, 'Строим календарь…')));
    const data = await dutiesApi.calendar(month);
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const today = todayStr();
    const byDate = new Map();
    for (const d of data.duties ?? []) {
      if (!byDate.has(d.date)) byDate.set(d.date, []);
      byDate.get(d.date).push(d);
    }

    const grid = el('.cal');
    for (const w of ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс']) {
      grid.appendChild(el('.cal-head', {}, w));
    }

    const gridStart = startOfWeek(dateToStr(first));
    for (let i = 0; i < 42; i += 1) {
      const date = addDays(gridStart, i);
      const inMonth = date.slice(0, 7) === month;
      const list = byDate.get(date) ?? [];
      const cell = el(`.cal-cell${inMonth ? '' : '.is-out'}${date === today ? '.is-today' : ''}`, {
        style: list.length ? { '--team-color': list[0].teamColor ?? '#6366f1' } : null,
        onclick: inMonth ? () => openDay(date) : null,
      },
      el('.cal-num', {}, String(parseDate(date).getDate())),
      date === today ? el('.cal-today-tag', {}, 'сегодня') : null,
      );
      if (list.length) {
        for (const d of list) {
          cell.appendChild(el(`.cal-duty`, {
            title: `${d.teamName} · ${d.dutyTime}`,
            onclick: (e) => { e.stopPropagation(); navigate(`/duties/${d.id}`); },
          },
          el('span.truncate', {}, `№${d.teamNumber}`),
          el('span.truncate.text-soft', {}, d.dutyTime ?? ''),
          ));
        }
        const st = STATUS_META[list[0].status] ?? STATUS_META.planned;
        cell.appendChild(el(`.cal-status.dot-${st.tone}`, { title: st.label }));
      } else {
        cell.appendChild(el('.cal-empty', {}, inMonth ? '·' : ''));
      }
      grid.appendChild(cell);
      if (i >= 34 && addDays(gridStart, i + 1).slice(0, 7) !== month) break;
    }

    headBox.replaceChildren(
      el('div', {},
        el('h1.page-title', {}, `${MONTH_NAMES[m - 1]} ${y}`),
        el('p.text-mute', {}, data.duties?.length
          ? `${data.duties.length} дежурств в этом месяце`
          : 'В этом месяце дежурств пока нет'),
      ),
      el('.page-actions', {},
        el('.row.gap-1', {},
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { month = shiftMonth(month, -1); load(); } }, '←'),
          el('button.btn.btn-sm.btn-soft', { type: 'button', onclick: () => { month = today.slice(0, 7); load(); } }, 'Сегодня'),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => { month = shiftMonth(month, 1); load(); } }, '→'),
        ),
        canAny('duty.create', 'duty.schedule') ? el('button.btn.btn-sm.btn-primary', { type: 'button', onclick: () => openCreate() }, '＋ Создать') : null,
      ),
    );
    gridBox.replaceChildren(grid, el('div.divider'), legend);
  }

  async function openDay(date) {
    try {
      const { duties } = await dutiesApi.list({ from: date, to: date });
      const body = duties.length
        ? el('div', { style: { display: 'grid', gap: '10px' } }, duties.map((d) => el(`.duty-card${d.isToday ? '.is-today' : ''}`, {
          style: { '--team-color': d.teamColor },
          role: 'button', tabindex: 0,
          onclick: () => { m.close(); navigate(`/duties/${d.id}`); },
          onkeydown: (e) => { if (e.key === 'Enter') { m.close(); navigate(`/duties/${d.id}`); } },
        },
        el('.duty-date', {},
          el('span.d', {}, String(Number(date.slice(8, 10)))),
          el('span.m', {}, date.slice(5, 7)),
        ),
        el('.grow', { style: { minWidth: 0 } },
          el('.fw-650.truncate', {}, d.teamName ?? `Команда №${d.teamNumber}`),
          el('.text-xs.text-mute', {}, d.dutyTime ?? ''),
        ),
        badge(STATUS_META[d.status]?.label ?? d.status, STATUS_META[d.status]?.tone ?? 'neutral'),
        )))
        : el('p.text-mute', {}, 'На этот день дежурств нет.');

      const m = modal({
        title: parseDate(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }),
        body,
        size: 'sm',
      });
    } catch (error) { err(error.message); }
  }

  function openCreate() {
    const date = el('input.input', { type: 'date', required: true, value: todayStr() });
    const team = el('select.select', { required: true },
      el('option', { value: '' }, '— команда —'),
      state.teams.map((t) => el('option', { value: t.id }, t.name)));
    const time = el('input.input', { value: '08:00 – 08:20', maxlength: 60, required: true });
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Создать');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            const { duty } = await dutiesApi.create({ date: date.value, teamId: team.value, dutyTime: time.value.trim() });
            ok('Дежурство создано');
            m.close();
            navigate(`/duties/${duty.id}`);
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Дата', date, { required: true }),
    field('Команда', team, { required: true }),
    field('Время и место', time, { required: true }),
    submit,
    );
    const m = modal({ title: 'Новое дежурство', body: form, size: 'sm' });
  }

  await load();
  return el('.page.page-enter', {}, headBox, gridBox);
}
