/**
 * Каркас приложения: боковое меню, верхняя панель, мобильная нижняя навигация.
 * Пункты меню фильтруются по permissions из /api/auth/me.
 */
import { el, mount, clear, initials } from './lib/dom.js';
import { state, can, canAny, isManager, isStarosta } from './lib/store.js';
import { navigate, currentRoute } from './lib/router.js';
import { avatar, badge } from './lib/ui.js';

const NAV = [
  { group: 'Работа' },
  { path: '/', icon: '🏠', label: 'Главная', perm: null },
  { path: '/duties', icon: '📋', label: 'Дежурства', perm: 'duty.view.all' },
  { path: '/calendar', icon: '🗓', label: 'Календарь', perm: 'duty.view.all' },
  { path: '/teams', icon: '👥', label: 'Команды', perm: 'team.view.all' },
  { path: '/messages', icon: '✉️', label: 'Сообщения', perm: 'message.view', badgeKey: 'unread' },
  { path: '/photos', icon: '📸', label: 'Фотографии', perm: 'photo.view.team' },
  { group: 'Личное' },
  { path: '/profile', icon: '👤', label: 'Профиль', perm: null },
  { group: 'Управление', perm: 'user.view.all' },
  { path: '/users', icon: '🎓', label: 'Ученики', perm: 'user.view.all' },
  { path: '/admin', icon: '⚙️', label: 'Панель старосты', perm: 'stats.view.all' },
];

const MOBILE = ['/', '/duties', '/calendar', '/messages', '/profile'];
const MOBILE_ICON = {
  '/': '🏠', '/duties': '📋', '/calendar': '🗓', '/teams': '👥', '/messages': '✉️', '/profile': '👤',
};

export const TITLES = {
  '/': ['Главная', 'сводка по дежурствам'],
  '/duties': ['Дежурства', 'расписание и отметки'],
  '/calendar': ['Календарь', 'сетка месяца'],
  '/teams': ['Команды', 'составы и ответственные'],
  '/messages': ['Сообщения', 'объявления и личные'],
  '/photos': ['Фотографии', 'галерея дежурств'],
  '/profile': ['Профиль', 'данные и пароль'],
  '/users': ['Ученики', 'каталог класса'],
  '/admin': ['Панель старосты', 'настройки и журнал'],
};

function visibleItems() {
  return NAV.filter((n) => {
    if (n.group) return n.perm ? can(n.perm) : true;
    return !n.perm || can(n.perm);
  });
}

function isActivePath(path, routePath) {
  if (path === '/') return routePath === '/';
  return routePath === path || routePath.startsWith(`${path}/`);
}

let refs = {};

export function buildShell(root, viewNode) {
  const navEl = el('.nav');
  const topbarTitle = el('.topbar-title', {}, 'DUTY HUB');
  const topbarSub = el('.topbar-sub', {}, '');
  const topbarUser = el('button.btn.btn-ghost.topbar-user', {
    type: 'button', onclick: () => navigate('/profile'),
  });

  const sidebar = el('aside.sidebar', {},
    el('.brand', {},
      el('.brand-logo', {}, '⚡'),
      el('div', {},
        el('.brand-title', {}, 'DUTY HUB'),
        el('.brand-sub', {}, state.classInfo.name || '5 «Г»'),
      ),
    ),
    navEl,
    el('.sidebar-foot', {},
      el('.user-chip', { onclick: () => navigate('/profile') },
        avatar(state.user, 'md'),
        el('div.grow', {},
          el('.list-title.truncate', {}, state.user?.fullName ?? '—'),
          el('.list-sub.truncate', {}, state.roleLabel || 'Ученик'),
        ),
        '›',
      ),
    ),
  );

  const bottomnav = el('nav.bottomnav', { 'aria-label': 'Основная навигация' },
    MOBILE.map((path) => el('button.bn-item', {
      type: 'button', dataset: { path },
      onclick: () => navigate(path),
    }, el('span.bn-ico', {}, MOBILE_ICON[path]), el('span', {}, TITLES[path][0]))),
  );

  viewNode.className = 'content';
  const main = el('.main', {},
    el('header.topbar', {}, topbarTitle, el('.grow'), topbarSub, topbarUser),
    viewNode,
    bottomnav,
  );

  mount(root, el('.shell', {}, sidebar, main));
  refs = { navEl, topbarTitle, topbarSub, topbarUser, content: viewNode, sidebarUser: sidebar.querySelector('.user-chip') };
  renderNav();
  renderTopbar();
  return refs;
}

export function renderNav() {
  if (!refs.navEl) return;
  const path = currentRoute().path;
  clear(refs.navEl);
  for (const item of visibleItems()) {
    if (item.group) {
      refs.navEl.appendChild(el('.nav-label', {}, item.group));
      continue;
    }
    const active = isActivePath(item.path, path);
    const node = el(`a.nav-item${active ? '.is-active' : ''}`, {
      href: `#${item.path}`,
      onclick: (e) => { e.preventDefault(); navigate(item.path); },
    },
    el('.nav-icon', {}, item.icon),
    el('span.grow', {}, item.label),
    item.badgeKey === 'unread' && state.unread > 0
      ? el('span.nav-badge', {}, String(state.unread > 99 ? '99+' : state.unread))
      : null,
    );
    refs.navEl.appendChild(node);
  }

  for (const b of document.querySelectorAll('.bn-item')) {
    b.classList.toggle('is-active', isActivePath(b.dataset.path, path));
  }
}

export function renderTopbar() {
  if (!refs.topbarTitle) return;
  const path = currentRoute().path;
  const base = Object.entries(TITLES).find(([p]) => isActivePath(p, path));
  const [title, sub] = base ? TITLES[base[0]] : ['DUTY HUB', state.classInfo.name ?? ''];
  refs.topbarTitle.textContent = title;
  refs.topbarSub.textContent = sub;

  mount(refs.topbarUser,
    el('.topbar-user-inner', {},
      avatar(state.user, 'sm', { title: false }),
      el('div.topbar-user-text', {},
        el('.topbar-user-name', {}, state.user?.fullName ?? ''),
        el('.topbar-user-role', {}, state.roleLabel || ''),
      ),
    ),
  );
  const chip = refs.sidebarUser;
  if (chip) {
    mount(chip,
      avatar(state.user, 'md'),
      el('div.grow', {},
        el('.list-title.truncate', {}, state.user?.fullName ?? '—'),
        el('.list-sub.truncate', {}, state.roleLabel || 'Ученик'),
      ),
      '›',
    );
  }
}

export function pageHead(title, subtitle, actions = null) {
  return el('.page-head', {},
    el('div', {},
      el('h1.page-title', {}, title),
      subtitle ? el('p.text-mute', {}, subtitle) : null,
    ),
    actions ? el('.page-actions', {}, actions) : null,
  );
}

export function contentEl() { return refs.content; }
