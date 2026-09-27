/**
 * Точка входа SPA: инициализация сессии, каркас, маршруты, guard по ролям.
 *
 * Узел #view создаётся один раз и никогда не пересоздаётся: роутер всегда
 * монтирует страницу в него. Меняется только «обвязка» — сайдбар и топбар.
 */
import { el, mount } from './lib/dom.js';
import { state, bootstrap, subscribe, can } from './lib/store.js';
import { route, setGuard, setNotFound, start, navigate, mountInto, afterRender } from './lib/router.js';
import { buildShell, renderNav, renderTopbar, TITLES } from './shell.js';
import { empty } from './lib/ui.js';
import { welcomePage, loginPage, registerPage } from './pages/auth.js';
import { dashboardPage } from './pages/dashboard.js';
import { dutiesPage } from './pages/duties.js';
import { dutyPage } from './pages/duty.js';
import { calendarPage } from './pages/calendar.js';
import { teamsPage, teamPage } from './pages/teams.js';
import { messagesPage } from './pages/messages.js';
import { photosPage } from './pages/photos.js';
import { profilePage } from './pages/profile.js';
import { usersPage, userPage } from './pages/users.js';
import { adminPage } from './pages/admin.js';

const root = document.getElementById('app');
const bootScreen = document.getElementById('boot');
const view = el('section.content#view', { id: 'view', tabindex: '-1' });

const PUBLIC_ROUTES = new Set(['/', '/login', '/register']);
const ROUTE_PERMISSION = {
  '/duties': 'duty.view.all',
  '/calendar': 'duty.view.all',
  '/teams': 'team.view.all',
  '/messages': 'message.view',
  '/photos': 'photo.view.team',
  '/users': 'user.view.all',
  '/admin': 'stats.view.all',
};

/* ─────────────────────────── маршруты ─────────────────────────── */

route('/', async (ctx) => (state.authenticated ? dashboardPage(ctx) : welcomePage(ctx)));
route('/login', async (ctx) => (state.authenticated ? goHome() : loginPage(ctx)));
route('/register', async (ctx) => (state.authenticated ? goHome() : registerPage(ctx)));
route('/duties', dutiesPage);
route('/duties/:id', dutyPage);
route('/calendar', calendarPage);
route('/teams', teamsPage);
route('/teams/:id', teamPage);
route('/messages', messagesPage);
route('/photos', photosPage);
route('/profile', profilePage);
route('/users', usersPage);
route('/users/:id', userPage);
route('/admin', adminPage);

setNotFound(async () => el('.card', {}, el('.card-body', {},
  empty({
    icon: '🧭',
    title: 'Страница не найдена',
    text: 'Возможно, ссылка устарела.',
    action: el('button.btn.btn-primary', { type: 'button', onclick: () => navigate('/') }, 'На главную'),
  }),
)));

function goHome() {
  navigate('/', { replace: true });
  return el('.page', {}, el('.loading-block', {}, el('.spinner')));
}

/* ─────────────────────────── guard ─────────────────────────── */

setGuard((current) => {
  if (!state.ready) return false;
  const path = current.path;

  if (PUBLIC_ROUTES.has(path)) {
    return state.authenticated ? '/' : true;
  }
  if (!state.authenticated) {
    const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?')) : '';
    sessionStorage.setItem('dh:redirect', `${path}${query}`);
    return '/login';
  }
  const perm = ROUTE_PERMISSION[path];
  if (perm && !can(perm)) return '/';
  return true;
});

/* ──────────────────────── обвязка приложения ──────────────────────── */

function renderChrome() {
  if (state.authenticated) {
    buildShell(root, view);
    renderNav();
    renderTopbar();
  } else {
    view.className = 'content content-guest';
    mount(root, view);
  }
}

// Подсветка активного пункта и заголовка после каждой навигации.
afterRender((current) => {
  if (!state.authenticated) return;
  renderNav();
  renderTopbar();
  view.scrollTop = 0;
  document.title = `${TITLES[current.path]?.[0] ?? 'DUTY HUB'} · DUTY HUB`;
});

/* ─────────────────────────── старт ─────────────────────────── */

async function main() {
  try {
    await bootstrap();
  } catch (err) {
    console.error('[app] не удалось получить сессию', err);
  }

  renderChrome();
  mountInto(view);
  bootScreen?.remove();

  // Возврат на страницу, с которой гостя выкинуло на вход.
  if (state.authenticated) {
    const target = sessionStorage.getItem('dh:redirect');
    sessionStorage.removeItem('dh:redirect');
    if (target && target !== '/' && ROUTE_PERMISSION[target] && can(ROUTE_PERMISSION[target])) {
      navigate(target, { replace: true });
      return;
    }
  }

  await start();
}

subscribe((_, reason) => {
  if (reason === 'unread') { renderNav(); return; }
  if (reason !== 'session') return;
  renderChrome();
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  if (!state.authenticated && !PUBLIC_ROUTES.has(path)) navigate('/', { replace: true });
});

main();
