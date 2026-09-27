/** Экраны для гостя: приветствие, вход, регистрация. */
import { el, formData, mount, humanDate } from '../lib/dom.js';
import { authApi, ApiError } from '../lib/api.js';
import { state, applySession, clearSession } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import { err, ok, field, withBusy } from '../lib/ui.js';

const ROLE_CARDS = [
  { role: 'member', label: 'Ученик', icon: '✔', desc: 'Отмечается в дежурстве, сдаёт фотоотчёт', code: false },
  { role: 'curator', label: 'Куратор', icon: '◆', desc: 'Проверка дежурств, фотографий, объявления', code: true },
  { role: 'starosta', label: 'Староста', icon: '★', desc: 'Полный доступ: расписание, ученики, роли, настройки', code: true },
];

function authShell(...children) {
  return el('.auth-wrap', {},
    el('.auth-main', {}, ...children),
    el('.auth-aside', {},
      el('.auth-aside-brand', {},
        el('.brand-logo', {}, '⚡'),
        el('div', {},
          el('.brand-title', {}, 'DUTY HUB'),
          el('.brand-sub', {}, state.classInfo.name || '5 «Г»'),
        ),
      ),
      el('h2.auth-title', {}, 'Дежурства класса — под контролем'),
      el('p.auth-sub', {}, 'Расписание, отметки, фотографии и объявления в одном месте. Каждый видит только то, что ему положено по роли.'),
      el('.auth-list', {},
        [
          ['🗓', 'Календарь дежурств на месяц'],
          ['✅', 'Отметки участников с историей'],
          ['📸', 'Фотоотчёт с проверкой куратора'],
          ['✉️', 'Объявления всему классу'],
        ].map(([i, t]) => el('.auth-list-item', {}, el('span', {}, i), el('span', {}, t))),
      ),

    ),
  );
}

/* ───────────────────────── приветствие ───────────────────────── */

export async function welcomePage() {
  const info = state.classInfo ?? {};
  return el('.auth-wrap', {},
    el('.auth-main.center', {},
      el('div', { style: { maxWidth: '440px', width: '100%' } },
        el('.auth-card', {},
          el('.boot-logo', { style: { margin: '0 auto 18px', animation: 'none' } }, '⚡'),
          el('h1.auth-title', { style: { textAlign: 'center' } }, 'DUTY HUB'),
          el('p.auth-sub', { style: { textAlign: 'center' } },
            info.name ? `Система дежурств класса ${info.name}` : 'Система дежурств класса'),
          info.school ? el('p.text-xs.text-soft', { style: { textAlign: 'center', marginTop: '-8px' } }, info.school) : null,

          el('.divider'),

          el('div.grid.grid-2', { style: { gap: '10px' } },
            el('button.btn.btn-primary.btn-lg.btn-block', { type: 'button', onclick: () => navigate('/login') }, 'Войти'),
            info.registrationOpen
              ? el('button.btn.btn-outline.btn-lg.btn-block', { type: 'button', onclick: () => navigate('/register') }, 'Регистрация')
              : el('button.btn.btn-ghost.btn-lg.btn-block', { type: 'button', disabled: true, title: 'Регистрация закрыта' }, 'Регистрация закрыта'),
          ),

          !info.registrationOpen
            ? el('.warn-box', { style: { marginTop: '14px' } }, 'Регистрация новых пользователей закрыта старостой класса.')
            : null,


          el('p.text-xs.text-soft', { style: { textAlign: 'center', marginTop: '18px' } },
            `Сегодня ${humanDate(new Date().toISOString().slice(0, 10))}`),
        ),
      ),
    ),
    el('.auth-aside', {},
      el('.auth-aside-brand', {},
        el('.brand-logo', {}, '⚡'),
        el('div', {}, el('.brand-title', {}, 'DUTY HUB'), el('.brand-sub', {}, 'Дежурства 5 «Г»')),
      ),
      el('h2.auth-title', {}, 'Одна система вместо тетрадок'),
      el('p.auth-sub', {}, 'Каждый ученик видит своё расписание, ответственный — команду, куратор — проверку, староста — весь класс.'),
      el('.auth-list', {},
        [['🗓', 'Календарь дежурств'], ['✅', 'Отметки и история'], ['📸', 'Фотоотчёт'], ['✉️', 'Объявления']]
          .map(([i, t]) => el('.auth-list-item', {}, el('span', {}, i), el('span', {}, t))),
      ),
    ),
  );
}

/* ───────────────────────── вход ───────────────────────── */

export async function loginPage() {
  const login = el('input.input', { name: 'username', autocomplete: 'username', required: true, placeholder: 'логин' });
  const password = el('input.input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••' });
  const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, 'Войти');

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      await withBusy(submit, async () => {
        try {
          const payload = await authApi.login(login.value.trim(), password.value);
          applySession(payload);
          ok(`Здравствуйте, ${payload.user.firstName}!`);
          navigate('/');
        } catch (error) {
          err(error.message);
          password.value = '';
          password.focus();
        }
      });
    },
  },
  field('Логин', login, { required: true }),
  field('Пароль', password, { required: true }),
  el('div', { style: { marginTop: '18px' } }, submit),
  );

  return authShell(
    el('div', { style: { maxWidth: '400px', width: '100%' } },
      el('a.btn.btn-ghost.btn-sm', { href: '#/', onclick: (e) => { e.preventDefault(); navigate('/'); } }, '← На главную'),
      el('h1.auth-title', { style: { marginTop: '14px' } }, 'Вход в систему'),
      el('p.auth-sub', {}, 'Введите логин и пароль, выданные старостой или куратором.'),
      el('.auth-card', { style: { marginTop: '18px' } }, form),

    ),
  );
}

/* ───────────────────────── регистрация ───────────────────────── */

export async function registerPage() {
  if (state.classInfo?.registrationOpen === false) {
    return authShell(el('div', { style: { maxWidth: '420px', width: '100%' } },
      el('h1.auth-title', {}, 'Регистрация закрыта'),
      el('.warn-box', {}, 'Староста класса временно закрыл регистрацию новых пользователей.'),
      el('button.btn.btn-primary.btn-block', { type: 'button', onclick: () => navigate('/login') }, 'Войти'),
    ));
  }

  const first = el('input.input', { name: 'firstName', required: true, placeholder: 'Иван', autocomplete: 'given-name' });
  const last = el('input.input', { name: 'lastName', required: true, placeholder: 'Петров', autocomplete: 'family-name' });
  const middle = el('input.input', { name: 'middleName', placeholder: 'Отчество (необязательно)' });
  // Дефис в конце класса символов обязателен к экранированию: HTML `pattern`
  // компилируется с флагом `v`, где голый `-` внутри [] — синтаксическая ошибка.
  const username = el('input.input', { name: 'username', required: true, placeholder: 'ivanpetrov', autocomplete: 'username', pattern: '[A-Za-z0-9_.\\-]{3,24}' });
  const password = el('input.input', { name: 'password', type: 'password', required: true, minlength: 6, autocomplete: 'new-password', placeholder: 'минимум 6 символов' });
  const confirm = el('input.input', { name: 'confirm', type: 'password', required: true, autocomplete: 'new-password' });
  // Команду на регистрации не выбирают: состав формирует староста через «Ученики».
  const code = el('input.input', { name: 'code', placeholder: 'код приглашения', autocomplete: 'off' });

  const avatarFile = el('input', { type: 'file', name: 'avatar', accept: 'image/jpeg,image/png,image/webp,image/gif', required: true });
  const avatarBox = el('.uploader', {},
    avatarFile,
    el('.uploader-preview', {},
      el('span.avatar.avatar-xl', {}, '＋'),
      el('span.uploader-hint', {}, 'Фото профиля'),
    ),
  );
  avatarFile.addEventListener('change', () => {
    const f = avatarFile.files?.[0];
    const box = avatarBox.querySelector('.avatar');
    if (!f) { box.textContent = '＋'; return; }
    const url = URL.createObjectURL(f);
    mount(box, el('img', { src: url, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' } }));
  });

  let chosenRole = 'member';
  const codeField = field('Код приглашения', code, { hint: 'Код выдаёт староста класса' });
  const roleWrap = el('.role-grid');
  const paintRoles = () => {
    for (const card of roleWrap.children) {
      card.classList.toggle('is-selected', card.dataset.role === chosenRole);
    }
    // Код нужен только для ролей, которые нельзя получить самостоятельно.
    const needsCode = Boolean(ROLE_CARDS.find((r) => r.role === chosenRole)?.code);
    codeField.hidden = !needsCode;
    code.required = needsCode;
  };
  for (const r of ROLE_CARDS) {
    roleWrap.appendChild(el('.role-card.card.card-pad-sm', {
      dataset: { role: r.role },
      onclick: () => {
        chosenRole = r.role;
        paintRoles();
      },
    },
    el('.row.gap-1', {},
      el('.role-ico', {}, r.icon),
      el('div.grow', {},
        el('.fw-700', {}, r.label, r.code ? el('span.role-lock', { title: 'Нужен код приглашения' }, ' 🔑') : null),
        el('.text-xs.text-mute', {}, r.desc),
      ),
    ),
    ));
  }
  paintRoles();

  const submit = el('button.btn.btn-primary.btn-lg.btn-block', { type: 'submit' }, 'Зарегистрироваться');

  const form = el('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      if (password.value !== confirm.value) {
        err('Пароли не совпадают');
        confirm.focus();
        return;
      }
      const fd = new FormData(form);
      fd.set('role', chosenRole);
      await withBusy(submit, async () => {
        try {
          const payload = await authApi.register(fd);
          applySession(payload);
          ok(`Добро пожаловать, ${payload.user.firstName}!`);
          navigate('/');
        } catch (error) {
          if (error instanceof ApiError && error.status === 0) { err('Нет связи с сервером'); return; }
          err(error.message);
        }
      });
    },
  },
  el('.grid.grid-2', {}, field('Имя', first, { required: true }), field('Фамилия', last, { required: true })),
  field('Отчество', middle),
  el('.grid.grid-2', { style: { marginTop: '12px' } }, field('Логин', username, { required: true, hint: '3–24 символа: латиница, цифры, _ . -' }), field('Пароль', password, { required: true })),
  field('Повторите пароль', confirm, { required: true }),
  el('.divider'),
  el('.label', {}, 'Ваша роль'),
  roleWrap,
  codeField,
  el('.divider'),
  field('Фото профиля', avatarBox, { required: true, hint: 'JPEG, PNG, WebP или GIF, до 6 МБ. Фото обязательно — по нему вас узнают.' }),
  el('div', { style: { marginTop: '20px' } }, submit),
  el('p.text-xs.text-mute', { style: { marginTop: '12px', textAlign: 'center' } },
    'Команду назначит староста класса в разделе «Ученики» — при регистрации выбирать её не нужно.'),
  );

  return authShell(el('div', { style: { maxWidth: '560px', width: '100%' } },
    el('a.btn.btn-ghost.btn-sm', { href: '#/', onclick: (e) => { e.preventDefault(); navigate('/'); } }, '← На главную'),
    el('h1.auth-title', { style: { marginTop: '14px' } }, 'Регистрация'),
    el('p.auth-sub', {}, 'Заполните анкету — она увидит староста класса.'),
    el('.auth-card', { style: { marginTop: '18px' } }, form),
  ));
}
