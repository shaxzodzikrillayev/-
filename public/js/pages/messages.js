/** Сообщения и объявления: лента, отправка, отметки прочтения. */
import { el, debounce } from '../lib/dom.js';
import { messagesApi, authApi, teamsApi } from '../lib/api.js';
import { state, can, canAny, isManager, refreshUnread } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, badge, empty, segment, toast, err, ok, modal, field, withBusy, confirmDialog, timeAgoLabel as ago,
} from '../lib/ui.js';

const SCOPES = [
  { value: 'all', label: 'Все' },
  { value: 'unread', label: 'Непрочитанные' },
  { value: 'notices', label: 'Объявления' },
  { value: 'mine', label: 'Мои' },
];

const AUDIENCES = [
  { value: 'class', label: 'Весь класс' },
  { value: 'team', label: 'Команда' },
  { value: 'user', label: 'Конкретному ученику' },
];

export async function messagesPage(ctx) {
  const scope = ctx.query.scope ?? 'all';
  const wrap = el('.page.page-enter');

  const listBox = el('.msg-list');
  const countBox = el('p.text-sm.text-mute');

  const scopeSeg = segment(SCOPES, scope, (v) => { location.hash = `#/messages?scope=${v}`; });

  wrap.appendChild(el('.page-head', {},
    el('div', {},
      el('h1.page-title', {}, 'Сообщения'),
      countBox,
    ),
    el('.page-actions', {},
      can('message.send') ? el('button.btn.btn-primary', { type: 'button', onclick: () => openCompose() }, '＋ Написать') : null,
    ),
  ));

  wrap.appendChild(el('.card.card-pad', { style: { marginBottom: '16px' } }, scopeSeg));
  wrap.appendChild(listBox);

  async function load() {
    listBox.replaceChildren(el('.loading-block', {}, el('.spinner'), el('span.text-mute', {}, 'Загружаем сообщения…')));
    const data = await messagesApi.list({ scope });
    countBox.textContent = data.unreadCount
      ? `${data.unreadCount} непрочитанных из ${data.messages.length}`
      : `${data.messages.length} всего`;
    listBox.replaceChildren(...(data.messages.length
      ? data.messages.map((m) => messageCard(m))
      : [el('.card', {}, empty({
        icon: '✉️',
        title: 'Сообщений нет',
        text: can('message.send') ? 'Отправьте первое объявление классу.' : 'Здесь появятся объявления старосты и куратора.',
      }))]));
  }

  function messageCard(m) {
    const canDelete = m.author?.id === state.user?.id || isManager();
    const node = el(`.msg-card${m.isRead ? '' : '.is-unread'}`, {
      onclick: async () => {
        if (!m.isRead) {
          try {
            await messagesApi.markRead(m.id);
            m.isRead = true;
            node.classList.remove('is-unread');
            await refreshUnread();
          } catch { /* не критично */ }
        }
      },
    },
    el('.row.gap-1', {},
      m.author ? avatar(m.author, 'md') : el('.avatar.avatar-md', {}, '🏫'),
      el('.grow', { style: { minWidth: 0 } },
        el('.row-between.gap-1', {},
          el('div', { style: { minWidth: 0 } },
            el('.row.gap-1', {},
              el('span.fw-700', {}, m.author?.fullName ?? 'Система'),
              m.author?.roleLabel ? badge(m.author.roleLabel, m.author.role === 'starosta' ? 'brand' : 'info') : null,
              m.kind === 'notice' ? badge('Объявление', 'warning') : null,
              m.isRead ? null : badge('Новое', 'danger'),
            ),
            el('.text-xs.text-mute.truncate', {}, [
              m.audienceLabel,
              ago(m.createdAt),
            ].filter(Boolean).join(' · ')),
          ),
          canDelete
            ? el('button.btn.btn-xs.btn-ghost', {
              type: 'button', title: 'Удалить',
              onclick: async (e) => {
                e.stopPropagation();
                const yes = await confirmDialog({ title: 'Удалить сообщение?', text: 'Сообщение будет удалено у всех.', confirmText: 'Удалить', danger: true });
                if (!yes) return;
                try { await messagesApi.remove(m.id); ok('Сообщение удалено'); load(); refreshUnread(); }
                catch (error) { err(error.message); }
              },
            }, '🗑')
            : null,
        ),
        el('.msg-body', {}, m.title),
        el('p.text-sm.text-soft', { style: { whiteSpace: 'pre-wrap' } }, m.body),
        m.targetUser ? el('.text-xs.text-mute', {}, `Адресат: ${m.targetUser.fullName}`) : null,
      ),
    ),
    );
    return node;
  }

  /* ─────────── отправка ─────────── */
  async function openCompose() {
    const kind = el('select.select', {},
      el('option', { value: 'notice' }, 'Объявление'),
      el('option', { value: 'message' }, 'Личное сообщение'),
    );
    const audience = el('select.select', {},
      AUDIENCES.filter((a) => a.value === 'class' ? isManager() : true).map((a) => el('option', { value: a.value }, a.label)),
    );
    const title = el('input.input', { required: true, minlength: 2, maxlength: 120, placeholder: 'О чём сообщение?' });
    const body = el('textarea.textarea', { required: true, minlength: 2, maxlength: 4000, rows: 6, placeholder: 'Текст сообщения…' });
    const teamField = el('div', { style: { display: 'none' } },
      field('Команда', el('select.select', { required: true },
        state.teams.map((t) => el('option', { value: t.id }, t.name)))),
    );
    const userField = el('div', { style: { display: 'none' } });
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Отправить');

    audience.addEventListener('change', async () => {
      teamField.style.display = audience.value === 'team' ? '' : 'none';
      userField.style.display = audience.value === 'user' ? '' : 'none';
      if (audience.value === 'user' && !userField.childElementCount) {
        const { users } = await authApi.directory('');
        const sel = el('select.select', { required: true },
          users.filter((u) => u.id !== state.user.id).map((u) => el('option', { value: u.id }, `${u.fullName} (@${u.username})`)));
        userField.appendChild(field('Получатель', sel));
      }
    });

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            const payload = {
              kind: kind.value,
              audience: audience.value,
              title: title.value.trim(),
              body: body.value.trim(),
            };
            if (audience.value === 'team') payload.teamId = Number(teamField.querySelector('select').value);
            if (audience.value === 'user') payload.targetUserId = Number(userField.querySelector('select').value);
            await messagesApi.create(payload);
            ok('Сообщение отправлено');
            m.close();
            location.hash = '#/messages';
            reload();
          } catch (error) { err(error.message); }
        });
      },
    },
    el('.grid.grid-2', {}, field('Тип', kind), field('Адресат', audience)),
    teamField,
    userField,
    el('div', { style: { marginTop: '12px' } }, field('Заголовок', title, { required: true })),
    el('div', { style: { marginTop: '12px' } }, field('Текст', body, { required: true })),
    submit,
    );

    const m = modal({ title: 'Новое сообщение', body: form, size: 'lg' });
  }

  await load();
  return wrap;
}
