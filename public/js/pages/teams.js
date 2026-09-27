/** Команды: список, карточка команды, состав, назначение ответственного. */
import { el, dateLabel, plural, debounce } from '../lib/dom.js';
import { teamsApi, usersApi, dutiesApi } from '../lib/api.js';
import { state, can, canAny, isStarosta, isManager, leadsTeam } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, avatarStack, badge, statusBadge, teamChip, empty, segment, toast, err, ok, warn,
  confirmDialog, modal, field, selectField, withBusy, MARK_META, STATUS_META,
} from '../lib/ui.js';

/* ═══════════════════════ список команд ═══════════════════════ */

export async function teamsPage() {
  const { teams } = await teamsApi.list();
  const wrap = el('.page.page-enter', {},
    el('.page-head', {},
      el('div', {},
        el('h1.page-title', {}, 'Команды'),
        el('p.text-mute', {}, `${teams.length} ${plural(teams.length, 'команда', 'команды', 'команд')} в классе`),
      ),
      el('.page-actions', {},
        can('team.edit') ? el('button.btn.btn-primary', { type: 'button', onclick: () => openCreate() }, '＋ Создать команду') : null,
      ),
    ),
  );

  const grid = el('.grid.grid-3');
  for (const t of teams) {
    const rate = t.dutyCount ? Math.round((t.doneCount / t.dutyCount) * 100) : 0;
    grid.appendChild(el(`.team-card${t.isMyTeam ? '.is-mine' : ''}`, {
      style: { '--team-color': t.color },
      role: 'button', tabindex: 0,
      onclick: () => navigate(`/teams/${t.id}`),
      onkeydown: (e) => { if (e.key === 'Enter') navigate(`/teams/${t.id}`); },
    },
    el('.team-card-strip'),
    el('.card-body', {},
      el('.row-between.gap-1', { style: { marginBottom: '10px' } },
        el('div', {},
          el('h3', { style: { fontSize: '1.05rem' } }, `Команда №${t.number}`),
          el('.text-sm.text-mute', {}, t.name.replace(/^Команда №\d+\s*—\s*/, '')),
        ),
        badge(`${rate}%`, rate >= 70 ? 'success' : rate >= 40 ? 'warning' : 'danger'),
      ),
      el('.row.gap-1', { style: { marginBottom: '10px' } },
        t.responsible
          ? el('.user-chip', { style: { border: 'none', background: 'transparent', padding: 0 } },
            avatar(t.responsible, 'sm'),
            el('div', { style: { minWidth: 0 } },
              el('.list-title.truncate', {}, t.responsible.fullName),
              el('.list-sub', {}, 'Ответственный'),
            ))
          : el('.text-sm.text-mute', {}, 'Ответственный не назначен'),
      ),
      el('.row-between', {},
        avatarStack(t.members ?? []),
        el('.text-xs.text-soft', {}, `${t.memberCount ?? t.members?.length ?? 0} уч. · ${t.doneCount}/${t.dutyCount} дежурств`),
      ),
    ),
    ));
  }
  wrap.appendChild(grid);

  function openCreate() {
    const number = el('input.input', { type: 'number', min: 1, max: 99, required: true, value: String(teams.length + 1) });
    const name = el('input.input', { required: true, minlength: 3, maxlength: 60, placeholder: 'Команда №6 — Мечта' });
    const color = el('input.input', { type: 'color', value: '#6366f1', style: { padding: '4px', height: '44px' } });
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Создать');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            const { team } = await teamsApi.create({ number: Number(number.value), name: name.value.trim(), color: color.value });
            ok('Команда создана');
            m.close();
            navigate(`/teams/${team.id}`);
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Номер', number, { required: true }),
    field('Название', name, { required: true, hint: 'Можно оставить «Команда №N»' }),
    field('Цвет', color),
    submit,
    );
    const m = modal({ title: 'Новая команда', body: form, size: 'sm' });
  }

  return wrap;
}

/* ═══════════════════════ карточка команды ═══════════════════════ */

export async function teamPage(ctx) {
  const id = Number(ctx.params.id);
  const data = await teamsApi.get(id);
  const { team, viewer, todayDuty, upcoming, history, week, stats } = data;

  const wrap = el('.page.page-enter', {},
    el('.page-head', {},
      el('div', {},
        el('.row.row-wrap.gap-1', { style: { marginBottom: '6px' } },
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => history.back() }, '← Назад'),
          viewer.isResponsible ? badge('Вы ответственный', 'brand') : null,
        ),
        el('h1.page-title', {}, team.name),
        el('p.text-mute', {}, `${team.memberCount} ${plural(team.memberCount, 'участник', 'участника', 'участников')} · выполнено ${stats.done} из ${stats.duties} дежурств`),
      ),
      el('.page-actions', {},
        can('team.assign') ? el('button.btn.btn-soft', { type: 'button', onclick: openAssign }, 'Назначить ответственного') : null,
        canAny('team.edit', 'team.members') ? el('button.btn.btn-ghost', { type: 'button', onclick: openMembers }, 'Состав') : null,
        can('team.edit') ? el('button.btn.btn-ghost', { type: 'button', onclick: openEdit }, 'Настройки') : null,
      ),
    ),
  );

  /* сводка */
  wrap.appendChild(el('.grid.grid-4', { style: { marginBottom: '18px' } },
    miniStat('📋', stats.duties, 'всего дежурств', 'brand'),
    miniStat('✅', stats.done, 'выполнено', 'mint'),
    miniStat('🚫', stats.missed, 'не выполнено', 'rose'),
    miniStat('⭐', stats.served, 'отметок «дежурил»', 'amber'),
  ));

  const columns = el('.grid.grid-sidebar');
  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  /* сегодняшнее дежурство с отметками */
  if (todayDuty) {
    left.appendChild(el('.card', {},
      el('.card-head', {},
        el('div', {},
          el('h3', {}, 'Дежурство сегодня'),
          el('.text-xs.text-mute', {}, todayDuty.dutyTime ?? ''),
        ),
        el('.row.gap-1', {},
          statusBadge(todayDuty.status),
          el('a.btn.btn-sm.btn-soft', { href: `#/duties/${todayDuty.id}`, onclick: (e) => { e.preventDefault(); navigate(`/duties/${todayDuty.id}`); } }, 'Открыть'),
        ),
      ),
      el('.card-body', {},
        todayDuty.marks?.length
          ? el('.members-grid', {}, todayDuty.marks.map((m) => el(`.member-card${m.id === state.user?.id ? '.is-lead' : ''}`, {},
            avatar(m, 'sm'),
            el('div.grow', { style: { minWidth: 0 } },
              el('.member-name.truncate', {}, m.shortName || m.fullName),
              el('.text-xs', {}, MARK_META[m.mark]?.label ?? m.mark),
            ),
          )))
          : el('p.text-mute', {}, 'Отметки ещё не проставлены.'),
      ),
    ));
  } else {
    left.appendChild(el('.card', {}, el('.card-body', {},
      empty({ icon: '☕', title: 'Дежурства сегодня нет', text: 'Команда отдыхает.' }),
    )));
  }

  /* неделя */
  if (week?.length) {
    left.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Эта неделя')),
      el('.card-body', { style: { display: 'grid', gap: '8px' } },
        week.map((d) => miniDutyRow(d)),
      ),
    ));
  }

  /* предстоящие */
  if (upcoming?.length) {
    left.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Ближайшие дежурства')),
      el('.card-body', { style: { display: 'grid', gap: '8px' } },
        upcoming.slice(0, 10).map((d) => miniDutyRow(d)),
      ),
    ));
  }

  /* история */
  if (history?.length) {
    left.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'История')),
      el('.card-body', { style: { display: 'grid', gap: '8px' } },
        history.slice(0, 15).map((d) => miniDutyRow(d)),
      ),
    ));
  }

  columns.appendChild(left);

  /* состав */
  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });
  right.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, `Состав · ${team.members?.length ?? 0}`)),
    el('.card-body', {},
      team.members?.length
        ? el('div', { style: { display: 'grid', gap: '8px' } }, team.members.map((m) => el(`.member-card${m.id === team.responsibleId ? '.is-lead' : ''}`, {
          role: 'button', tabindex: 0, style: { cursor: 'pointer' },
          onclick: () => navigate(`/users/${m.id}`),
        },
        avatar(m, 'sm'),
        el('div.grow', { style: { minWidth: 0 } },
          el('.member-name.truncate', {}, m.fullName),
          el('.text-xs.text-mute', {}, `@${m.username}`),
        ),
        m.id === team.responsibleId ? badge('Ответственный', 'brand') : null,
        )))
        : el('p.text-mute', {}, 'Участники не добавлены.'),
    ),
  ));
  columns.appendChild(right);
  wrap.appendChild(columns);

  /* ─────────── модалки управления ─────────── */

  async function openAssign() {
    const { users } = await usersApi.list({ status: 'active' });
    const candidates = users.filter((u) => u.role === 'member' || u.role === 'responsible');
    const sel = el('select.select', {},
      el('option', { value: '' }, '— не назначен —'),
      candidates.map((u) => el('option', { value: u.id, selected: u.id === team.responsibleId },
        `${u.fullName}${u.teamId === team.id ? ` · уже в команде` : ` · команда ${u.teamNumber ?? '—'}`}`)),
    );
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Назначить');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            await teamsApi.setResponsible(id, sel.value === '' ? null : Number(sel.value));
            ok('Ответственный назначен');
            m.close();
            reload();
          } catch (error) { err(error.message); }
        });
      },
    },
    el('.info-box', {}, 'Ответственный отмечает участников, ведёт фотоотчёт и закреплён за будущими дежурствами команды. Староста или куратор не могут быть ответственными.'),
    el('div', { style: { marginTop: '14px' } }, field('Ответственный', sel)),
    submit,
    );
    const m = modal({ title: `Ответственный команды №${team.number}`, body: form, size: 'sm' });
  }

  async function openMembers() {
    const { users } = await usersApi.list({ status: 'active' });
    const selected = new Set((team.members ?? []).map((m) => m.id));
    const list = el('div', { style: { display: 'grid', gap: '6px', maxHeight: '46vh', overflowY: 'auto' } },
      users.map((u) => {
        const box = el('label.member-card', { style: { cursor: 'pointer' } },
          el('input', {
            type: 'checkbox', checked: selected.has(u.id),
            onchange: (e) => { if (e.target.checked) selected.add(u.id); else selected.delete(u.id); },
          }),
          avatar(u, 'sm'),
          el('div.grow', { style: { minWidth: 0 } },
            el('.member-name.truncate', {}, u.fullName),
            el('.text-xs.text-mute', {}, `${u.roleLabel} · команда ${u.teamNumber ?? '—'}`),
          ),
        );
        return box;
      }),
    );
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Сохранить состав');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            await teamsApi.setMembers(id, [...selected]);
            ok('Состав обновлён');
            m.close();
            reload();
          } catch (error) { err(error.message); }
        });
      },
    },
    el('p.text-sm.text-mute', {}, 'Отметьте участников команды. Изменение состава сбрасывает отметки в будущих дежурствах.'),
    el('div', { style: { marginTop: '12px' } }, list),
    submit,
    );
    const m = modal({ title: `Состав команды №${team.number}`, body: form, size: 'lg' });
  }

  function openEdit() {
    const number = el('input.input', { type: 'number', min: 1, max: 99, value: team.number, required: true });
    const name = el('input.input', { value: team.name, maxlength: 60, required: true, minlength: 3 });
    const color = el('input.input', { type: 'color', value: team.color, style: { padding: '4px', height: '44px' } });
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Сохранить');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            await teamsApi.update(id, { number: Number(number.value), name: name.value.trim(), color: color.value });
            ok('Команда обновлена');
            m.close();
            reload();
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Номер', number, { required: true }),
    field('Название', name, { required: true }),
    field('Цвет', color),
    submit,
    );
    const m = modal({ title: 'Настройки команды', body: form, size: 'sm' });
  }

  return wrap;
}

function miniStat(icon, value, label, tone) {
  return el(`.stat.tone-${tone}`, {},
    el('.stat-icon', {}, icon),
    el('div.grow', {},
      el('.stat-value', {}, String(value ?? 0)),
      el('.stat-label', {}, label),
    ),
  );
}

function miniDutyRow(d) {
  return el('.duty-card', {
    style: { '--team-color': d.teamColor ?? '#6366f1' },
    role: 'button', tabindex: 0,
    onclick: () => navigate(`/duties/${d.id}`),
    onkeydown: (e) => { if (e.key === 'Enter') navigate(`/duties/${d.id}`); },
  },
  el('.duty-date', {},
    el('span.d', {}, d.date.slice(8, 10)),
    el('span.m', {}, d.date.slice(5, 7)),
  ),
  el('.grow', { style: { minWidth: 0 } },
    el('.text-sm', {}, dateLabel(d.date)),
    el('.text-xs.text-soft.truncate', {}, d.dutyTime ?? ''),
  ),
  statusBadge(d.status),
  );
}
