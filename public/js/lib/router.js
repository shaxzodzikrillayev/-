/**
 * Hash-роутер. #/duties/12 → { name: '/duties/:id', params: { id: '12' } }.
 *
 * Контракт страницы: async-функция, возвращающая DOM-узел (или null).
 * Роутер сам разбирает маршрут, прогоняет guard, вызывает загрузчик,
 * монтирует результат в контейнер и сам отрисовывает ошибки/скелетоны.
 */

const routes = [];
let notFoundLoader = null;
let guard = null;
let container = null;
let current = { path: '/', name: '', params: {} };
let token = 0;
let started = false;
let onAfterRender = null;

/* ───────────────────────── регистрация ───────────────────────── */

function compile(pattern) {
  const keys = [];
  const source = pattern
    // Сначала выделяем параметры заглушкой: «:» не входит в набор
    // экранируемых символов, иначе подстановка не найдёт параметр.
    .replace(/:([A-Za-z0-9_]+)/g, (_, key) => { keys.push(key); return '\u0000'; })
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0000/g, '([^/]+)');
  return { rx: new RegExp(`^${source}/?$`), keys };
}

export function route(pattern, loader) {
  const { rx, keys } = compile(pattern);
  routes.push({ pattern, rx, keys, loader });
}

export function setNotFound(loader) { notFoundLoader = loader; }
export function setGuard(fn) { guard = fn; }
export function mountInto(node) { container = node; }
export function afterRender(fn) { onAfterRender = fn; }
export const currentRoute = () => current;

/* ───────────────────────── навигация ───────────────────────── */

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  return {
    path: pathPart.replace(/\/+$/, '') || '/',
    query: Object.fromEntries(new URLSearchParams(queryPart ?? '')),
  };
}

function match(path) {
  for (const r of routes) {
    const m = r.rx.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { pattern: r.pattern, loader: r.loader, params };
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (location.hash === target) { resolve(); return; }
  if (replace) { history.replaceState(null, '', target); resolve(); }
  else location.hash = target;
}

/** Перерисовать текущий маршрут (после смены сессии или прав). */
export function reload() { return resolve(); }

/* ───────────────────────── рендер ───────────────────────── */

function show(node) {
  if (!container) return;
  container.replaceChildren();
  if (node) container.appendChild(node);
  container.classList.remove('page-enter');
  void container.offsetWidth;
  container.classList.add('page-enter');
  container.scrollTop = 0;
  scrollTo({ top: 0, behavior: 'instant' in document.body.style ? 'instant' : 'auto' });
  onAfterRender?.(current);
}

export async function resolve() {
  const my = ++token;
  const { path, query } = parseHash();
  const hit = match(path);
  const chosen = hit ?? { pattern: '*', loader: notFoundLoader, params: {} };
  current = { path, name: chosen.pattern, params: { ...chosen.params, query } };
  if (!chosen.loader) return;

  if (guard) {
    const verdict = await guard(current);
    if (my !== token) return;
    if (verdict === false) { navigate('/', { replace: true }); return; }
    if (typeof verdict === 'string' && verdict !== path) { navigate(verdict, { replace: true }); return; }
  }

  const ctx = { path, params: { ...current.params }, query, signal: makeSignal(my) };
  try {
    const node = await chosen.loader(ctx);
    if (my !== token) return;
    show(node);
  } catch (err) {
    if (my !== token || err?.name === 'AbortError') return;
    console.error('[router]', current.path, err);
    show(renderError(err, () => resolve()));
  }
}

/** Позволяет странице отменять устаревшие загрузки при быстрой навигации. */
function makeSignal(my) {
  return {
    get aborted() { return my !== token; },
    addEventListener() {},
  };
}

export function renderError(err, retry) {
  const wrap = document.createElement('div');
  wrap.className = 'card card-pad';
  wrap.innerHTML = `
    <div class="empty">
      <div class="empty-ico">⚠️</div>
      <h3>Не удалось загрузить страницу</h3>
      <p class="text-mute err-text"></p>
    </div>`;
  wrap.querySelector('.err-text').textContent = err?.message ?? 'Неизвестная ошибка';
  if (retry) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-soft';
    btn.type = 'button';
    btn.textContent = 'Повторить';
    btn.addEventListener('click', retry);
    wrap.querySelector('.empty').appendChild(btn);
  }
  return wrap;
}

export function start() {
  if (started) return;
  started = true;
  addEventListener('hashchange', () => resolve());
  if (!location.hash) history.replaceState(null, '', '#/');
  return resolve();
}
