/** Профиль: свои данные, аватар, смена пароля, история дежурств. */
import { el, dateLabel, plural } from '../lib/dom.js';
import { authApi, dutiesApi, statsApi } from '../lib/api.js';
import { state, can, applySession, clearSession } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, badge, roleBadge, statusBadge, markBadge, empty, segment, ok, err, warn,
  modal, field, withBusy, timeAgoLabel, MARK_META,
} from '../lib/ui.js';

export async function profilePage() {
  const me = state.user;
  const [history, stats] = await Promise.all([
    dutiesApi.myHistory().catch(() => ({ duties: [], stats: {} })),
    statsApi.overview().catch(() => null),
  ]);

  const wrap = el('.page.page-enter', {},
    el('.page-head', {},
      el('div', {},
        el('h1.page-title', {}, 'Мой профиль'),
        el('p.text-mute', {}, `@${me.username} · ${state.roleLabel}`),
      ),
      el('.page-actions', {},
        el('button.btn.btn-ghost', { type: 'button', onclick: doLogout }, 'Выйти'),
      ),
    ),
  );

  const columns = el('.grid.grid-sidebar');

  /* ─────────── карточка профиля ─────────── */
  const avatarInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,image/gif' });
  const avatarBox = avatar(me, 'xl', { title: false });
  const preview = el('.uploader', { style: { minHeight: 'auto', padding: '16px' } },
    avatarInput,
    el('.uploader-preview', {}, avatarBox, el('span.uploader-hint', {}, 'Сменить фото')),
  );
  avatarInput.addEventListener('change', () => {
    const f = avatarInput.files?.[0];
    if (!f) return;
    avatarBox.replaceChildren(el('img', {
      src: URL.createObjectURL(f), alt: '',
      style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' },
    }));
    preview.classList.add('has-file');
  });

  const first = el('input.input', { value: me.firstName, required: true });
  const last = el('input.input', { value: me.lastName, required: true });
  const middle = el('input.input', { value: me.middleName ?? '' });
  const saveBtn = el('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Сохранить изменения');

  const profileForm = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      await withBusy(saveBtn, async () => {
        try {
          const fd = new FormData();
          fd.set('firstName', first.value.trim());
          fd.set('lastName', last.value.trim());
          fd.set('middleName', middle.value.trim());
          if (avatarInput.files?.[0]) fd.set('avatar', avatarInput.files[0]);
          const payload = await authApi.updateProfile(fd);
          applySession(payload);
          ok('Профиль обновлён');
          reload();
        } catch (error) { err(error.message); }
      });
    },
  },
  field('Имя', first, { required: true }),
  field('Фамилия', last, { required: true }),
  field('Отчество', middle),
  saveBtn,
  );

  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  left.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, 'Данные профиля')),
    el('.card-body', {},
      el('.row.gap-1', { style: { marginBottom: '14px' } },
        avatar(me, 'xl', { ring: true }),
        el('div', {},
          el('h3', { style: { fontSize: '1.1rem' } }, me.fullName),
          el('.row.gap-1', { style: { marginTop: '6px' } },
            roleBadge(me.role, state.roleLabel),
            me.teamName ? badge(me.teamName, 'neutral') : null,
            me.isActive ? badge('Активен', 'success') : badge('Заблокирован', 'danger'),
          ),
          el('.text-xs.text-mute', { style: { marginTop: '6px' } },
            me.lastLoginAt ? `Вход: ${timeAgoLabel(me.lastLoginAt)}` : 'Это ваш первый вход'),
        ),
      ),
      el('.divider'),
      preview,
      el('.divider'),
      profileForm,
      el('.hint', { style: { marginTop: '10px' } }, 'Логин, роль и команду меняет только староста класса.'),
    ),
  ));

  /* статистика */
  const s = stats?.myStats ?? history.stats ?? {};
  left.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, 'Мои показатели')),
    el('.card-body', {},
      el('.grid.grid-4', { style: { gap: '10px' } },
        kpi('Всего', s.total ?? 0, 'brand'),
        kpi('Дежурил', s.served ?? 0, 'mint'),
        kpi('Не дежурил', s.notServed ?? 0, 'amber'),
        kpi('Пропусков', s.absent ?? 0, 'rose'),
      ),
    ),
  ));

  /* история дежурств */
  const historyBox = el('.card', {},
    el('.card-head', {}, el('h3', {}, `История дежурств · ${history.duties?.length ?? 0}`)),
    el('.card-body', {},
      history.duties?.length
        ? el('div', { style: { display: 'grid', gap: '8px' } }, history.duties.map((d) => el('.duty-card', {
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
        markBadge(d.myMark),
        )))
        : empty({ icon: '📋', title: 'История пуста', text: 'Здесь появятся все ваши дежурства.' }),
    ),
  );
  left.appendChild(historyBox);
  columns.appendChild(left);

  /* пароль */
  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });
  const cur = el('input.input', { type: 'password', required: true, autocomplete: 'current-password' });
  const nw = el('input.input', { type: 'password', required: true, minlength: 6, autocomplete: 'new-password' });
  const nw2 = el('input.input', { type: 'password', required: true, minlength: 6, autocomplete: 'new-password' });
  const pwBtn = el('button.btn.btn-primary.btn-block', { type: 'submit' }, 'Сменить пароль');

  right.appendChild(el('.card', {},
    el('.card-head', {}, el('h3', {}, 'Смена пароля')),
    el('.card-body', {},
      el('form', {
        onsubmit: async (e) => {
          e.preventDefault();
          if (nw.value !== nw2.value) { err('Новые пароли не совпадают'); return; }
          await withBusy(pwBtn, async () => {
            try {
              const res = await authApi.changePassword(cur.value, nw.value);
              if (res?.authenticated) applySession(res);
              ok('Пароль изменён. Остальные сессии закрыты.');
              e.target.reset();
            } catch (error) { err(error.message); }
          });
        },
      },
      field('Текущий пароль', cur, { required: true }),
      el('div', { style: { marginTop: '10px' } }, field('Новый пароль', nw, { required: true, hint: 'Минимум 6 символов' })),
      el('div', { style: { marginTop: '10px' } }, field('Повторите новый пароль', nw2, { required: true })),
      el('div', { style: { marginTop: '16px' } }, pwBtn),
      ),
    ),
  ));

  /* моя команда */
  if (stats?.myTeam) {
    const t = stats.myTeam;
    right.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Моя команда')),
      el('.card-body', {},
        el('.row-between', {},
          el('div', {},
            el('.fw-700', {}, t.name),
            el('.text-xs.text-mute', {}, t.isResponsible ? 'Вы ответственный' : 'Вы участник'),
          ),
          el('a.btn.btn-sm.btn-ghost', { href: `#/teams/${t.id}`, onclick: (e) => { e.preventDefault(); navigate(`/teams/${t.id}`); } }, 'Открыть →'),
        ),
        el('.divider'),
        el('.kv', {}, el('span.kv-k', {}, 'Дежурств команды'), el('span.kv-v', {}, t.stats?.total ?? 0)),
        el('.kv', {}, el('span.kv-k', {}, 'Выполнено'), el('span.kv-v', { style: { color: 'var(--mint-600)' } }, t.stats?.done ?? 0)),
        el('.kv', {}, el('span.kv-k', {}, 'Не выполнено'), el('span.kv-v', { style: { color: 'var(--rose-600)' } }, t.stats?.missed ?? 0)),
        t.responsible
          ? el('.user-chip', { style: { marginTop: '12px', border: 'none', background: 'transparent', padding: 0 } },
            avatar(t.responsible, 'sm'),
            el('div', {}, el('.list-title', {}, t.responsible.fullName), el('.list-sub', {}, 'Ответственный')))
          : null,
      ),
    ));
  }
  columns.appendChild(right);
  wrap.appendChild(columns);

  async function doLogout() {
    try { await authApi.logout(); } catch { /* всё равно разлогиниваем */ }
    clearSession();
    ok('Вы вышли из системы');
    navigate('/');
  }

  return wrap;
}

function kpi(label, value, tone) {
  return el(`.card.card-pad-sm.tone-${tone}`, { style: { textAlign: 'center' } },
    el('.stat-value', { style: { fontSize: '1.4rem' } }, String(value ?? 0)),
    el('.stat-label', {}, label),
  );
}
