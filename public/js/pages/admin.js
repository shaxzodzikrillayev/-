/** Панель старосты: сводка, команды, назначения, настройки, журнал действий. */
import { el, dateTime, plural } from '../lib/dom.js';
import { systemApi, teamsApi, usersApi } from '../lib/api.js';
import { state, can, isStarosta, isManager } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, badge, roleBadge, teamChip, empty, segment, ok, err, warn,
  confirmDialog, modal, field, withBusy, timeAgoLabel,
} from '../lib/ui.js';

const TABS = [
  { value: 'overview', label: 'Сводка' },
  { value: 'teams', label: 'Команды' },
  { value: 'settings', label: 'Настройки' },
  { value: 'audit', label: 'Журнал' },
];

export async function adminPage(ctx) {
  const tab = TABS.some((t) => t.value === ctx.query.tab) ? ctx.query.tab : 'overview';
  const wrap = el('.page.page-enter');

  wrap.appendChild(el('.page-head', {},
    el('div', {},
      el('h1.page-title', {}, 'Панель управления'),
      el('p.text-mute', {}, `${state.classInfo.name}${state.classInfo.school ? ` · ${state.classInfo.school}` : ''}`),
    ),
  ));

  const box = el('div', { style: { marginBottom: '16px' } },
    segment(TABS.filter((t) => t.value !== 'settings' || can('settings.manage')), tab, (v) => { location.hash = `#/admin?tab=${v}`; }),
  );
  wrap.appendChild(box);

  const body = el('div');
  wrap.appendChild(body);

  if (tab === 'overview') await renderOverview(body);
  else if (tab === 'teams') await renderTeams(body);
  else if (tab === 'settings') await renderSettings(body);
  else await renderAudit(body);

  return wrap;
}

/* ═══════════════════════ сводка ═══════════════════════ */

async function renderOverview(box) {
  const data = await systemApi.overview();
  const s = data.stats ?? {};

  box.appendChild(el('.grid.grid-4', { style: { marginBottom: '18px' } },
    kpi('👥', s.students, 'учеников', 'sky'),
    kpi('⭐', s.responsibles, 'ответственных', 'mint'),
    kpi('📋', s.todayDuties, 'дежурств сегодня', 'brand'),
    kpi('✅', s.doneToday, 'выполнено', 'mint'),
    kpi('📸', s.pendingPhotos, 'фото на проверке', 'amber'),
    kpi('🚫', s.missed, 'не выполнено', 'rose'),
  ));

  const columns = el('.grid.grid-sidebar');
  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  left.appendChild(el('.card', {},
    el('.card-head', {},
      el('h3', {}, 'Команды и ответственные'),
      el('a.btn.btn-sm.btn-ghost', { href: '#/admin?tab=teams', onclick: (e) => { e.preventDefault(); location.hash = '#/admin?tab=teams'; } }, 'Настроить →'),
    ),
    el('.card-body', { style: { display: 'grid', gap: '10px' } },
      data.teams.map((t) => el('.member-card', {},
        el('.team-dot', { style: { background: t.color, width: '12px', height: '12px', borderRadius: '50%', flex: '0 0 12px' } }),
        el('.grow', { style: { minWidth: 0 } },
          el('.member-name.truncate', {}, `№${t.number} ${t.name.replace(/^Команда №\d+\s*—\s*/, '')}`),
          el('.text-xs.text-mute', {}, `${t.members} уч. · ${t.done}/${t.duties} дежурств`),
        ),
        t.responsible
          ? el('.row.gap-1', {}, avatar(t.responsible, 'sm'), el('span.text-xs.truncate', {}, t.responsible.fullName))
          : badge('Нет ответственного', 'warning'),
      )),
    ),
  ));

  /* роли */
  const byRole = { starosta: [], curator: [], responsible: [], member: [] };
  for (const u of data.users) (byRole[u.role] ??= []).push(u);

  const roleRow = (role, list) => el('div', {},
    el('.row-between', { style: { marginBottom: '6px' } },
      roleBadge(role),
      el('span.text-xs.text-mute', {}, String(list.length)),
    ),
    el('.row.row-wrap.gap-1', {},
      list.slice(0, 12).map((u) => el('button', {
        type: 'button',
        title: `${u.fullName} (${u.roleLabel})`,
        style: { border: 'none', background: 'none', padding: 0, cursor: 'pointer' },
        onclick: () => navigate(`/users/${u.id}`),
      }, avatar(u, 'sm', { title: false }))),
      list.length > 12 ? el('span.text-xs.text-mute', {}, `и ещё ${list.length - 12}`) : null,
    ),
  );

  left.appendChild(el('.card', {},
    el('.card-head', {},
      el('h3', {}, 'Роли в классе'),
      el('a.btn.btn-sm.btn-ghost', { href: '#/users', onclick: (e) => { e.preventDefault(); navigate('/users'); } }, 'Каталог →'),
    ),
    el('.card-body', { style: { display: 'grid', gap: '14px' } },
      Object.entries(byRole).map(([role, list]) => roleRow(role, list)),
    ),
  ));
  columns.appendChild(left);

  /* быстрые действия */
  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });
  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Быстрые действия'),
    el('div', { style: { display: 'grid', gap: '8px', marginTop: '10px' } },
      can('user.create') ? el('button.btn.btn-soft.btn-block', { type: 'button', onclick: () => navigate('/users') }, '＋ Добавить ученика') : null,
      can('team.assign') ? el('button.btn.btn-soft.btn-block', { type: 'button', onclick: () => { location.hash = '#/admin?tab=teams'; } }, '★ Назначить ответственных') : null,
      can('photo.review') ? el('button.btn.btn-soft.btn-block', { type: 'button', onclick: () => navigate('/photos?scope=pending') }, `📸 Проверить фото${s.pendingPhotos ? ` (${s.pendingPhotos})` : ''}`) : null,
      can('message.send') ? el('button.btn.btn-soft.btn-block', { type: 'button', onclick: () => navigate('/messages') }, '✉️ Отправить объявление') : null,
      can('settings.manage') ? el('button.btn.btn-soft.btn-block', { type: 'button', onclick: () => { location.hash = '#/admin?tab=settings'; } }, '⚙️ Настройки класса') : null,
    ),
  ));

  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Регистрация'),
    el('p.text-sm.text-mute', { style: { marginTop: '6px' } },
      state.classInfo.registrationOpen
        ? 'Открыта — новые ученики могут зарегистрироваться как ответственные.'
        : 'Закрыта — регистрация новых пользователей недоступна.'),
  ));
  columns.appendChild(right);
  box.appendChild(columns);
}

/* ═══════════════════════ команды и назначения ═══════════════════════ */

async function renderTeams(box) {
  const [data, usersRes] = await Promise.all([
    systemApi.overview(),
    usersApi.list({ status: 'active' }),
  ]);
  const candidates = usersRes.users.filter((u) => u.role === 'member' || u.role === 'responsible');

  const list = el('div', { style: { display: 'grid', gap: '14px' } });
  for (const t of data.teams) {
    const sel = el('select.select', { style: { maxWidth: '320px' } },
      el('option', { value: '' }, '— не назначен —'),
      candidates.map((u) => el('option', { value: u.id, selected: u.id === t.responsibleId },
        `${u.fullName}${u.teamId && u.teamId !== t.id ? ` · сейчас в команде №${u.teamNumber}` : ''}${u.isActive ? '' : ' · заблокирован'}`)),
    );
    list.appendChild(el('.card.card-pad', {},
      el('.row-between.row-wrap.gap-1', {},
        el('div', { style: { minWidth: 0 } },
          el('.row.gap-1', {},
            el('.team-dot', { style: { background: t.color, width: '14px', height: '14px', borderRadius: '50%' } }),
            el('h3', { style: { fontSize: '1rem' } }, t.name),
          ),
          el('.text-xs.text-mute', { style: { marginTop: '3px' } }, `${t.members} участников · ${t.done} из ${t.duties} выполнено`),
        ),
        t.responsible
          ? el('.user-chip', { style: { border: 'none', background: 'transparent', padding: 0 } },
            avatar(t.responsible, 'sm'),
            el('span.text-sm.fw-650', {}, t.responsible.fullName))
          : badge('Нет ответственного', 'warning'),
      ),
      el('.divider'),
      el('.row.row-wrap.gap-1', { style: { alignItems: 'flex-end' } },
        el('div.grow', { style: { minWidth: '240px' } }, field('Ответственный', sel)),
        el('button.btn.btn-primary', {
          type: 'button',
          onclick: async (e) => {
            await withBusy(e.currentTarget, async () => {
              try {
                await teamsApi.setResponsible(t.id, sel.value === '' ? null : Number(sel.value));
                ok(`Команда №${t.number}: ответственный обновлён`);
                reload();
              } catch (error) { err(error.message); }
            });
          },
        }, 'Назначить'),
        el('a.btn.btn-ghost', { href: `#/teams/${t.id}`, onclick: (e) => { e.preventDefault(); navigate(`/teams/${t.id}`); } }, 'Состав →'),
      ),
    ));
  }
  box.appendChild(el('.card', { style: { padding: '0', border: 'none', boxShadow: 'none', background: 'transparent' } }, list));
}

/* ═══════════════════════ коды приглашения ═══════════════════════ */

function inviteCodesCard() {
  const body = el('.card-body', {}, el('.hint', {}, 'Загрузка кодов…'));
  const card = el('.card', { style: { marginTop: '18px' } },
    el('.card-head', {}, el('h3', {}, 'Коды приглашения')),
    body,
  );

  const paint = (codes) => {
    const row = (label, key, note) => {
      const value = codes[key] ?? '—';
      return el('.row.gap-2', { style: { marginTop: '10px' } },
        el('div.grow', {},
          el('.fw-700', {}, label),
          el('.text-xs.text-mute', {}, note),
        ),
        el('code.code-chip', { style: { fontSize: '18px', letterSpacing: '3px' } }, value),
      );
    };
    body.replaceChildren(
      el('.hint', {}, 'На странице регистрации ученик выбирает роль «Куратор» или «Староста» и вводит этот код. Без кода регистрация создаёт обычного ученика без команды.'),
      row('Куратор', 'invite_code_curator', 'Регистрация с правами куратора'),
      row('Староста', 'invite_code_starosta', 'Регистрация с полными правами'),
      el('button.btn.btn-soft', {
        type: 'button', style: { marginTop: '16px' },
        onclick: async (e) => {
          const yes = await confirmDialog({
            title: 'Выдать новые коды?',
            text: 'Прежние коды перестанут работать. Сообщите новые коды тем, кто ещё не зарегистрировался.',
            confirmText: 'Выдать новые',
          });
          if (!yes) return;
          await withBusy(e.currentTarget, async () => {
            try {
              const res = await systemApi.regenerateInviteCodes();
              paint(res.codes);
              ok('Новые коды выданы');
            } catch (error) { err(error.message); }
          });
        },
      }, '🔄 Выдать новые коды'),
    );
  };

  systemApi.inviteCodes()
    .then((r) => paint(r.codes))
    .catch((error) => body.replaceChildren(el('.warn-box', {}, error.message)));

  return card;
}

/* ═══════════════════════ настройки ═══════════════════════ */

async function renderSettings(box) {
  const data = await systemApi.settings();
  const inputs = {};

  const registration = el('label.switch', {},
    el('input', {
      type: 'checkbox', checked: data.values.registration_open === '1',
      onchange: (e) => { inputs.registration_open = e.target.checked ? '1' : '0'; },
    }),
    el('span.track'),
    el('span', {}, 'Регистрация новых пользователей'),
  );

  for (const f of data.fields) {
    if (f.key === 'registration_open') continue;
    inputs[f.key] = data.values[f.key];
  }

  const form = el('form', {},
    field('Название класса', el('input.input', {
      value: data.values.class_name, maxlength: 20,
      oninput: (e) => { inputs.class_name = e.target.value; },
    }), { hint: 'Отображается в шапке и на экране приветствия' }),
    el('div', { style: { marginTop: '12px' } }, field('Школа', el('input.input', {
      value: data.values.school_name, maxlength: 90,
      oninput: (e) => { inputs.school_name = e.target.value; },
    }))),
    el('div', { style: { marginTop: '12px' } }, field('Время дежурства по умолчанию', el('input.input', {
      value: data.values.duty_time_default, maxlength: 40,
      oninput: (e) => { inputs.duty_time_default = e.target.value; },
    }), { hint: 'Подставляется при создании нового дежурства' })),
    el('.divider'),
    registration,
    el('.hint', { style: { marginTop: '8px' } }, 'Если регистрация закрыта, новые ученики не смогут зарегистрироваться самостоятельно.'),
    el('button.btn.btn-primary', {
      type: 'submit', style: { marginTop: '18px' },
      onclick: async (e) => {
        e.preventDefault();
        await withBusy(e.currentTarget, async () => {
          try {
            await systemApi.saveSettings(inputs);
            state.classInfo.name = inputs.class_name;
            state.classInfo.school = inputs.school_name;
            state.classInfo.registrationOpen = inputs.registration_open === '1';
            ok('Настройки сохранены');
            reload();
          } catch (error) { err(error.message); }
        });
      },
    }, 'Сохранить настройки'),
  );

  box.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, 'Настройки класса')),
    el('.card-body', {}, form),
  ));

  box.appendChild(inviteCodesCard());

  box.appendChild(el('.card', { style: { marginTop: '18px' } },
    el('.card-head', {}, el('h3', {}, 'Опасная зона')),
    el('.card-body', {},
      el('.warn-box', {}, 'Удаление базы данных необратимо: будут потеряны все пользователи, дежурства, отметки и фотографии.'),
      el('button.btn.btn-danger', {
        type: 'button', style: { marginTop: '14px' },
        onclick: async () => {
          const yes = await confirmDialog({
            title: 'Удалить все данные?',
            text: 'Потребуется пересоздать базу и заново зарегистрировать всех учеников. Отменить это нельзя.',
            confirmText: 'Я понимаю риск',
            danger: true,
          });
          if (!yes) return;
          warn('Удаление данных выполняется на сервере: остановите процесс и удалите папку data/, затем запустите сервер заново.');
        },
      }, 'Удалить все данные'),
    ),
  ));
}

/* ═══════════════════════ журнал действий ═══════════════════════ */

async function renderAudit(box) {
  const { entries } = await systemApi.audit(200);

  const filter = el('input.input.input-icon', {
    type: 'search', placeholder: 'Фильтр по действию или пользователю…',
    oninput: () => paint(),
  }, el('span.input-icon', {}, '🔍'));

  const table = el('div');
  const paint = () => {
    const term = filter.value.trim().toLowerCase();
    const rows = entries.filter((e) => !term
      || e.action.toLowerCase().includes(term)
      || (e.user?.fullName ?? '').toLowerCase().includes(term)
      || (e.user?.username ?? '').toLowerCase().includes(term));
    if (!rows.length) {
      table.replaceChildren(el('.card-body', {}, empty({ icon: '📜', title: 'Записей нет' })));
      return;
    }
    table.replaceChildren(el('.card-body.table-wrap', {},
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Когда'), el('th', {}, 'Пользователь'),
          el('th', {}, 'Действие'), el('th', {}, 'Объект'), el('th', {}, 'IP'),
        )),
        el('tbody', {}, rows.map((e) => el('tr', {},
          el('td.text-xs.text-soft.nowrap', { title: dateTime(e.createdAt) }, timeAgoLabel(e.createdAt)),
          el('td', {}, e.user ? el('.row.gap-1', {}, avatar({ id: e.user.id, fullName: e.user.fullName, avatar: `/api/files/avatar/${e.user.id}`, initials: initialsOf(e.user.fullName) }, 'xs', { title: false }), el('span.text-sm', {}, e.user.fullName)) : el('span.text-mute', {}, '—')),
          el('td', {}, el('code.mono.text-xs', {}, e.action)),
          el('td.text-xs.text-mute', {}, `${e.entity}${e.entityId ? ` #${e.entityId}` : ''}`),
          el('td.text-xs.text-mute.mono', {}, e.ip || '—'),
        ))),
      ),
    ));
  };

  box.appendChild(el('.card', {},
    el('.card-head', {},
      el('div', {},
        el('h3', {}, 'Журнал действий'),
        el('.text-xs.text-mute', {}, `${entries.length} последних записей`),
      ),
      el('div', { style: { minWidth: '240px' } }, filter),
    ),
    table,
  ));
  paint();
}

function kpi(icon, value, label, tone) {
  return el(`.stat.tone-${tone}`, {},
    el('.stat-icon', {}, icon),
    el('div.grow', {}, el('.stat-value', {}, String(value ?? 0)), el('.stat-label', {}, label)),
  );
}

function initialsOf(fullName = '') {
  return String(fullName).split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
}
