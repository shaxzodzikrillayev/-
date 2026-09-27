/** Каталог учеников: поиск, фильтры, карточка, администрирование (староста). */
import { el, dateLabel, debounce, plural } from '../lib/dom.js';
import { usersApi } from '../lib/api.js';
import { state, can, canAny, isStarosta, isManager } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, badge, roleBadge, statusBadge, markBadge, teamChip, empty, segment,
  ok, err, warn, confirmDialog, modal, promptDialog, field, withBusy, timeAgoLabel, MARK_META,
} from '../lib/ui.js';

const ROLES = [
  { value: '', label: 'Все роли' },
  { value: 'starosta', label: 'Староста' },
  { value: 'curator', label: 'Куратор' },
  { value: 'responsible', label: 'Ответственные' },
  { value: 'member', label: 'Ученики' },
];

const STATUSES = [
  { value: '', label: 'Все' },
  { value: 'active', label: 'Активные' },
  { value: 'blocked', label: 'Заблокированные' },
];

/* ═══════════════════════ каталог ═══════════════════════ */

export async function usersPage(ctx) {
  const filters = {
    q: ctx.query.q ?? '',
    role: ctx.query.role ?? '',
    teamId: ctx.query.teamId ?? '',
    status: ctx.query.status ?? '',
  };

  const wrap = el('.page.page-enter');
  const listBox = el('.card');
  const countBox = el('p.text-sm.text-mute');

  const search = el('input.input.input-icon', {
    type: 'search', placeholder: 'Поиск по фамилии, имени или логину…', value: filters.q,
    oninput: debounce(() => { filters.q = search.value.trim(); load(); }, 350),
  }, el('span.input-icon', {}, '🔍'));

  const mk = (options, key) => el('select.select', {
    onchange: (e) => { filters[key] = e.target.value; load(); },
  }, options.map((o) => el('option', { value: o.value, selected: String(o.value) === String(filters[key]) }, o.label)));

  wrap.appendChild(el('.page-head', {},
    el('div', {}, el('h1.page-title', {}, 'Ученики'), countBox),
    el('.page-actions', {},
      can('user.create') ? el('button.btn.btn-primary', { type: 'button', onclick: () => openCreate() }, '＋ Добавить') : null,
    ),
  ));

  wrap.appendChild(el('.card.card-pad', { style: { marginBottom: '16px' } },
    el('.grid.grid-auto-sm', {},
      el('div.grow', {}, search),
      mk(ROLES, 'role'),
      mk([{ value: '', label: 'Все команды' }, ...state.teams.map((t) => ({ value: String(t.id), label: `№${t.number}` }))], 'teamId'),
      mk(STATUSES, 'status'),
    ),
  ));
  wrap.appendChild(listBox);

  async function load() {
    listBox.replaceChildren(el('.loading-block', {}, el('.spinner'), el('span.text-mute', {}, 'Загружаем…')));
    const params = {};
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    const data = await usersApi.list(params);
    countBox.textContent = `${data.total} ${plural(data.total, 'человек', 'человека', 'человек')}`;

    listBox.replaceChildren(el('.table-wrap', {},
      el('table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, 'Ученик'),
          el('th', {}, 'Логин'),
          el('th', {}, 'Роль'),
          el('th', {}, 'Команда'),
          el('th.t-center', {}, 'Дежурств'),
          el('th', {}, 'Статус'),
          el('th', {}, ''),
        )),
        el('tbody', {}, data.users.map((u) => userRow(u, data.canEdit))),
      ),
    ));
  }

  function userRow(u, canEdit) {
    const self = u.id === state.user?.id;
    return el(`tr${u.isActive ? '' : '.is-inactive'}`, {},
      el('td', {},
        el('.user-chip', { style: { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }, onclick: () => navigate(`/users/${u.id}`) },
          avatar(u, 'sm'),
          el('div', { style: { minWidth: 0 } },
            el('.list-title.truncate', {}, u.fullName, self ? el('span.text-xs.text-mute', {}, ' (это вы)') : null),
          ),
        ),
      ),
      el('td', {}, el('span.mono.text-sm', {}, u.username)),
      el('td', {}, roleBadge(u.role, u.roleLabel)),
      el('td', {}, u.teamName ? teamChip({ number: u.teamNumber, name: `№${u.teamNumber}`, color: u.teamColor }, { clickable: false }) : el('span.text-mute', {}, '—')),
      el('td.t-center', {}, String(u.dutyCount ?? 0)),
      el('td', {}, u.isActive ? badge('Активен', 'success') : badge('Заблокирован', 'danger')),
      el('td.t-right', {},
        el('.row.row-actions', { style: { justifyContent: 'flex-end' } },
          el('a.btn.btn-xs.btn-ghost', { href: `#/users/${u.id}`, onclick: (e) => { e.preventDefault(); navigate(`/users/${u.id}`); } }, 'Профиль'),
          canEdit ? el('button.btn.btn-xs.btn-soft', { type: 'button', onclick: () => openEdit(u) }, 'Изменить') : null,
          can('user.reset_password') ? el('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: () => resetPassword(u) }, 'Пароль') : null,
          can('user.block') && !self
            ? el(`button.btn.btn-xs.${u.isActive ? 'btn-ghost' : 'btn-success'}`, {
              type: 'button', onclick: () => toggleBlock(u),
            }, u.isActive ? 'Блокировать' : 'Разблокировать')
            : null,
        ),
      ),
    );
  }


  await load();
  return wrap;
}

/* ═══════════════ формы пользователя (общие для списка и карточки) ═══════════════ */
  function userForm(u = null) {
    const first = el('input.input', { value: u?.firstName ?? '', required: true, placeholder: 'Иван' });
    const last = el('input.input', { value: u?.lastName ?? '', required: true, placeholder: 'Петров' });
    const middle = el('input.input', { value: u?.middleName ?? '', placeholder: 'Отчество' });
    const username = el('input.input', {
      value: u?.username ?? '', required: !u, pattern: '[A-Za-z0-9_.\\-]{3,24}',
      placeholder: 'ivanpetrov', disabled: Boolean(u),
    });
    const role = el('select.select', { disabled: Boolean(u) },
      [
        ['member', 'Ученик класса'],
        ['responsible', 'Ответственный за дежурство'],
        ['starosta', 'Староста'],
        ['curator', 'Куратор'],
      ].map(([v, l]) => el('option', { value: v, selected: (u?.role ?? 'member') === v }, l)),
    );
    const team = el('select.select', {},
      el('option', { value: '' }, '— без команды —'),
      state.teams.map((t) => el('option', { value: t.id, selected: t.id === (u?.teamId ?? null) }, t.name)),
    );
    const password = el('input.input', { type: 'password', minlength: 6, placeholder: 'Если пусто — пароль = логин' });
    const avatarFile = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
    const avatarPreview = el('.uploader', { style: { minHeight: 'auto', padding: '14px' } },
      avatarFile,
      el('.uploader-preview', {},
        avatar(u ?? { initials: 'ФИ', fullName: '' }, 'lg', { title: false }),
        el('span.uploader-hint', {}, u ? 'Сменить фото' : 'Фото (необязательно)'),
      ),
    );
    avatarFile.addEventListener('change', () => {
      const f = avatarFile.files?.[0];
      if (!f) return;
      avatarPreview.querySelector('.avatar').replaceChildren(el('img', {
        src: URL.createObjectURL(f), alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' },
      }));
      avatarPreview.classList.add('has-file');
    });

    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, u ? 'Сохранить' : 'Создать');
    const result = { node: null, m: null };

    result.node = el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          await withBusy(submit, async () => {
            const fd = new FormData();
            fd.set('firstName', first.value.trim());
            fd.set('lastName', last.value.trim());
            fd.set('middleName', middle.value.trim());
            if (!u) fd.set('username', username.value.trim().toLowerCase());
            fd.set('role', role.value);
            fd.set('teamId', team.value || 'null');
            if (!u && password.value) fd.set('password', password.value);
            if (avatarFile.files?.[0]) fd.set('avatar', avatarFile.files[0]);
            if (role.value === 'responsible' && !team.value) {
              err('Для роли «Ответственный за дежурство» нужна команда');
              return;
            }
            try {
              if (u) {
                await usersApi.update(u.id, fd);
                ok('Данные обновлены');
              } else {
                await usersApi.create(fd);
                ok('Ученик добавлен');
              }
              result.m?.close();
              reload();
            } catch (error) { err(error.message); }
          });
        },
      },
      el('.grid.grid-2', {}, field('Имя', first, { required: true }), field('Фамилия', last, { required: true })),
      el('div', { style: { marginTop: '12px' } }, field('Отчество', middle)),
      el('.grid.grid-2', { style: { marginTop: '12px' } },
        field('Логин', username, { required: !u, hint: u ? 'Логин не меняется' : 'Латиница, цифры, _ . -' }),
        field('Команда', team),
      ),
      el('.grid.grid-2', { style: { marginTop: '12px' } },
        field('Роль', role, { hint: 'Ответственный за дежурство должен состоять в команде' }),
        field('Пароль', password, { hint: u ? null : 'Оставьте пустым, чтобы пароль = логин' }),
      ),
      el('div', { style: { marginTop: '12px' } }, avatarPreview),
      submit,
    );

    return result;
  }

  function openCreate() {
    const f = userForm(null);
    const m = modal({ title: 'Новый пользователь', body: f.node, size: 'lg' });
    f.m = m;
  }

  function openEdit(u) {
    const f = userForm(u);
    const m = modal({ title: `Учётные данные: ${u.fullName}`, body: f.node, size: 'lg' });
    f.m = m;
  }

  async function resetPassword(u) {
    const value = await promptDialog({
      title: 'Сброс пароля',
      text: `Новый пароль для ${u.fullName}. После сброса все его сессии будут закрыты, а при следующем входе он сможет сменить пароль сам.`,
      label: 'Новый пароль',
      type: 'text',
      confirmText: 'Сбросить',
    });
    if (!value) return;
    try {
      await usersApi.resetPassword(u.id, value);
      ok('Пароль сброшен');
    } catch (error) { err(error.message); }
  }

  async function toggleBlock(u) {
    const block = u.isActive;
    const yes = await confirmDialog({
      title: block ? 'Заблокировать ученика?' : 'Разблокировать ученика?',
      text: block
        ? `${u.fullName} не сможет войти в систему. Все его сессии будут закрыты.`
        : `${u.fullName} снова сможет войти в систему.`,
      confirmText: block ? 'Заблокировать' : 'Разблокировать',
      danger: block,
    });
    if (!yes) return;
    try {
      await usersApi.block(u.id, block);
      ok(block ? 'Ученик заблокирован' : 'Ученик разблокирован');
      reload();
    } catch (error) { err(error.message); }
  }
/* ═══════════════════════ карточка ученика ═══════════════════════ */

export async function userPage(ctx) {
  const id = Number(ctx.params.id);
  const data = await usersApi.get(id);
  const { user, team, duties, stats, viewer } = data;

  const wrap = el('.page.page-enter', {},
    el('.page-head', {},
      el('div', {},
        el('.row.row-wrap.gap-1', { style: { marginBottom: '6px' } },
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => history.back() }, '← Назад'),
          roleBadge(user.role, user.roleLabel),
          user.isActive ? badge('Активен', 'success') : badge('Заблокирован', 'danger'),
          viewer.isSelf ? badge('Это вы', 'info') : null,
        ),
        el('h1.page-title', {}, user.fullName),
        el('p.text-mute', {}, `@${user.username}${team ? ` · ${team.name}` : ''}`),
      ),
      el('.page-actions', {},
        can('user.edit') && !viewer.isSelf
          ? el('button.btn.btn-soft', { type: 'button', onclick: () => openEdit(user) }, 'Изменить')
          : null,
        can('user.reset_password') && !viewer.isSelf
          ? el('button.btn.btn-ghost', { type: 'button', onclick: () => resetPassword(user) }, 'Сбросить пароль')
          : null,
        can('user.block') && !viewer.isSelf
          ? el('button.btn.btn-ghost', {
            type: 'button',
            onclick: () => toggleBlock({ ...user, isActive: user.isActive }),
          }, user.isActive ? 'Заблокировать' : 'Разблокировать')
          : null,
      ),
    ),
  );

  const columns = el('.grid.grid-sidebar');
  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  left.appendChild(el('.grid.grid-4', { style: { marginBottom: '0' } },
    kpi('Всего', stats.total, 'brand'),
    kpi('Дежурил', stats.served, 'mint'),
    kpi('Не дежурил', stats.notServed, 'amber'),
    kpi('Пропусков', stats.absent, 'rose'),
  ));

  left.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, `Дежурства · ${duties.length}`)),
    el('.card-body', {},
      duties.length
        ? el('div', { style: { display: 'grid', gap: '8px' } }, duties.map((d) => el('.duty-card', {
          style: { '--team-color': d.teamColor },
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
          el('.text-xs.text-soft', {}, d.dutyTime ?? ''),
        ),
        markBadge(d.mark),
        )))
        : el('p.text-mute', {}, viewer.isSelf || viewer.isManager ? 'Дежурств пока нет.' : 'История дежурств другого ученика скрыта.'),
    ),
  ));
  columns.appendChild(left);

  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });
  right.appendChild(el('.card.card-pad', {},
    el('.row.gap-1', { style: { marginBottom: '12px' } },
      avatar(user, 'xl', { ring: true }),
      el('div', { style: { minWidth: 0 } },
        el('.fw-700', {}, user.fullName),
        el('.text-xs.text-mute', {}, `@${user.username}`),
        el('.row.gap-1', { style: { marginTop: '6px' } },
          roleBadge(user.role, user.roleLabel),
          team ? teamChip(team, { clickable: false }) : null,
        ),
      ),
    ),
    el('.divider'),
    el('.kv', {}, el('span.kv-k', {}, 'Команда'), el('span.kv-v', {}, team ? `№${team.number}` : '—')),
    user.leadsTeamId
      ? el('.kv', {}, el('span.kv-k', {}, 'Ответственный за'), el('span.kv-v', {}, `команду №${team?.number ?? '—'}`))
      : null,
    el('.kv', {}, el('span.kv-k', {}, 'В системе с'), el('span.kv-v', {}, timeAgoLabel(user.createdAt) || '—')),
    el('.kv', {}, el('span.kv-k', {}, 'Последний вход'), el('span.kv-v', {}, timeAgoLabel(user.lastLoginAt) || 'ни разу')),
  ));
  columns.appendChild(right);
  wrap.appendChild(columns);
  return wrap;
}

function kpi(label, value, tone) {
  return el(`.card.card-pad-sm.tone-${tone}`, { style: { textAlign: 'center' } },
    el('.stat-value', { style: { fontSize: '1.4rem' } }, String(value ?? 0)),
    el('.stat-label', {}, label),
  );
}
