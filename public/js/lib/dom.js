/** Мини-слой над DOM: безопасное создание элементов и часто используемые форматтеры. */

/**
 * Создание элемента: el('div.card', { onclick }, child, 'text')
 * Селектор поддерживает теги, #id и .class.
 */
export function el(spec, props = null, ...children) {
  const m = /^([a-zA-Z0-9-]+)?(#[^.]+)?((?:\.[^.#]+)*)$/.exec(spec);
  const node = document.createElement(m?.[1] || 'div');
  if (m?.[2]) node.id = m[2].slice(1);
  if (m?.[3]) node.className = m[3].split('.').filter(Boolean).join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = node.className ? `${node.className} ${v}` : v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

export function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function mount(node, ...children) { clear(node); append(node, children); return node; }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ───────────────────────── форматтеры ───────────────────────── */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WD = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const WD_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export const MONTH_NAMES = MONTHS_NOM;

export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function todayStr() {
  const d = new Date();
  return dateToStr(d);
}

export function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return dateToStr(d);
}

export function startOfWeek(s) {
  const d = parseDate(s);
  const w = d.getDay();
  d.setDate(d.getDate() + (w === 0 ? -6 : 1 - w));
  return dateToStr(d);
}

export function humanDate(s) {
  if (!s) return '';
  const d = parseDate(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function shortDate(s) {
  if (!s) return '';
  const d = parseDate(s);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function weekdayFull(s) { return s ? WD[parseDate(s).getDay()] : ''; }
export function weekdayShort(s) { return s ? WD_SHORT[parseDate(s).getDay()] : ''; }

export function relativeDay(s) {
  const t = todayStr();
  if (s === t) return 'Сегодня';
  if (s === addDays(t, 1)) return 'Завтра';
  if (s === addDays(t, -1)) return 'Вчера';
  return null;
}

export function dateLabel(s) {
  const rel = relativeDay(s);
  if (rel) return `${rel}, ${humanDate(s)}`;
  return `${weekdayFull(s)}, ${humanDate(s)}`;
}

/** 2026-09-27 → «27.09.2026, 12:30» */
export function dateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** «5 минут назад» */
export function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'только что';
  if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} ${plural(h, 'час', 'часа', 'часов')} назад`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} ${plural(d, 'день', 'дня', 'дней')} назад`;
  return dateTime(iso);
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function fileSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} Б`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`;
  return `${(b / 1024 / 1024).toFixed(1)} МБ`;
}

export function initials(user) {
  if (!user) return '?';
  if (user.initials) return user.initials;
  return `${(user.firstName?.[0] ?? '')}${(user.lastName?.[0] ?? '')}`.toUpperCase() || '?';
}

/** Смешивание цвета команды с прозрачностью — для плашек и полос. */
export function alpha(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? ''));
  if (!m) return `rgba(99,102,241,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Значение поля из объекта формы. */
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form).entries()) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function resetForm(form) { form.reset(); form.querySelectorAll('.is-invalid').forEach((n) => n.classList.remove('is-invalid')); }
