/**
 * UI-kit: тосты, модальные окна, аватары, бейджи, пустые состояния,
 * подтверждения, загрузка изображений с protected-эндпоинтов.
 */
import { el, mount, clear, initials, alpha, fileSize, timeAgo } from './dom.js';

/* ─────────────────────────── тосты ─────────────────────────── */

const TOAST_ICON = { success: '✓', error: '✕', warning: '!', info: 'i' };

export function toast(message, type = 'info', ms = 4200) {
  let host = document.querySelector('.toasts');
  if (!host) {
    host = el('.toasts', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  const node = el(`.toast.toast-${type}`, {},
    el('.toast-ico', {}, TOAST_ICON[type] ?? 'i'),
    el('.toast-text', {},
      el('.toast-title', {}, message),
    ),
    el('button.toast-x', { type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
  );
  let timer = setTimeout(close, ms);
  function close() {
    clearTimeout(timer);
    node.classList.add('is-closing');
    setTimeout(() => node.remove(), 180);
  }
  host.appendChild(node);
  return close;
}

export const ok = (m) => toast(m, 'success');
export const err = (m) => toast(m, 'error', 6000);
export const warn = (m) => toast(m, 'warning');

/* ─────────────────────────── модалки ─────────────────────────── */

let openModal = null;

export function modal({ title, body, footer, size = '', onClose, closeOnBackdrop = true }) {
  closeModal();
  const bodyEl = el('.modal-body', {}, body);
  const dialog = el(`.modal${size ? `.modal-${size}` : ''}`, {
    role: 'dialog', 'aria-modal': 'true', 'aria-label': title ?? 'Диалог',
  },
  el('.modal-head', {},
    el('h3.modal-title', {}, title ?? ''),
    el('button.modal-close', { type: 'button', 'aria-label': 'Закрыть', onclick: () => closeModal() }, '×'),
  ),
  bodyEl,
  footer ? el('.modal-foot', {}, footer) : null,
  );

  const overlay = el('.overlay', {
    onclick: (e) => { if (closeOnBackdrop && e.target === overlay) closeModal(); },
  }, dialog);

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeModal(); }
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => dialog.classList.add('is-open'));

  const focusable = dialog.querySelector('input, select, textarea, button:not(.modal-close)');
  focusable?.focus();

  openModal = {
    node: overlay,
    close() {
      document.removeEventListener('keydown', onKey);
      dialog.classList.remove('is-open');
      setTimeout(() => {
        overlay.remove();
        if (document.body.style.overflow === 'hidden') document.body.style.overflow = '';
      }, 160);
      openModal = null;
      onClose?.();
    },
  };
  return openModal;
}

export function closeModal() { openModal?.close(); }

export function confirmDialog({ title, text, confirmText = 'Подтвердить', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title,
      size: 'sm',
      body: el('p.text-mute', {}, text),
      footer: el('.row.gap-1', { style: { justifyContent: 'flex-end' } },
        el('button.btn.btn-ghost', { type: 'button', onclick: () => { finish(false); m.close(); } }, 'Отмена'),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, {
          type: 'button',
          onclick: () => { finish(true); m.close(); },
        }, confirmText),
      ),
      onClose: () => finish(false),
    });
  });
}

export function promptDialog({ title, text, label, value = '', type = 'text', confirmText = 'Сохранить' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const input = el('input.input', { type, value, required: true });
    const form = el('form', {
      onsubmit: (e) => { e.preventDefault(); const v = input.value.trim(); finish(v || null); m.close(); },
    }, el('.field', {}, label ? el('label.label', {}, label) : null, input));

    const m = modal({
      title,
      size: 'sm',
      body: el('div', {}, text ? el('p.text-mute', {}, text) : null, form),
      footer: el('.row.gap-1', { style: { justifyContent: 'flex-end' } },
        el('button.btn.btn-ghost', { type: 'button', onclick: () => { finish(null); m.close(); } }, 'Отмена'),
        el('button.btn.btn-primary', { type: 'button', onclick: () => { const v = input.value.trim(); finish(v || null); m.close(); } }, confirmText),
      ),
      onClose: () => finish(null),
    });
  });
}

/* ─────────────────────────── аватары ─────────────────────────── */

/** <img> с ленивой загрузкой и SVG-подменой при ошибке. */
export function avatar(user, size = 'md', { ring = false, title = true } = {}) {
  if (!user) return el(`.avatar.avatar-${size}`, {}, '?');
  const cls = `.avatar.avatar-${size}${ring ? '.avatar-ring' : ''}`;
  const alt = user.fullName || user.username || '';
  const img = el('img', {
    src: user.avatar || '',
    alt: title ? alt : '',
    loading: 'lazy',
    decoding: 'async',
    onerror: (e) => {
      const box = e.target.closest('.avatar');
      if (!box || box.dataset.fallback) return;
      box.dataset.fallback = '1';
      mount(box, initials(user));
    },
  });
  const box = el(cls, title ? { title: alt } : {}, img);
  if (user.isActive === false) box.classList.add('is-inactive');
  return box;
}

export function avatarStack(users = [], max = 4) {
  return el('.avatar-stack', {},
    users.slice(0, max).map((u) => avatar(u, 'sm')),
    users.length > max ? el('.avatar.avatar-sm.avatar-more', {}, `+${users.length - max}`) : null,
  );
}

/* ─────────────────────────── бейджи ─────────────────────────── */

export const MARK_META = {
  present: { label: 'Присутствовал', short: 'Присутствовал', tone: 'success' },
  absent: { label: 'Отсутствовал', short: 'Отсутствовал', tone: 'danger' },
  unmarked: { label: 'Не отмечен', short: 'Не отмечен', tone: 'neutral' },
  served: { label: 'Дежурил', short: 'Дежурил', tone: 'success' },
  not_served: { label: 'Не дежурил', short: 'Не дежурил', tone: 'warning' },
};
export const MARK_ORDER = ['served', 'present', 'not_served', 'absent', 'unmarked'];

export const STATUS_META = {
  planned: { label: 'Запланировано', tone: 'neutral' },
  pending: { label: 'Ожидает проверки', tone: 'warning' },
  done: { label: 'Выполнено', tone: 'success' },
  missed: { label: 'Не выполнено', tone: 'danger' },
};

export const CHECK_META = {
  pending: { label: 'На проверке', tone: 'warning' },
  approved: { label: 'Подтверждено', tone: 'success' },
  rejected: { label: 'Отклонено', tone: 'danger' },
};

export const ROLE_META = {
  starosta: { label: 'Староста', tone: 'brand', icon: '★' },
  curator: { label: 'Куратор', tone: 'info', icon: '◆' },
  responsible: { label: 'Ответственный', tone: 'success', icon: '✔' },
  member: { label: 'Ученик', tone: 'neutral', icon: '•' },
};

export function badge(text, tone = 'neutral', extra = '') {
  return el(`.badge.badge-${tone}${extra ? `.${extra}` : ''}`, {}, text);
}

export function markBadge(mark) {
  const m = MARK_META[mark] ?? MARK_META.unmarked;
  return badge(m.label, m.tone);
}

export function statusBadge(status) {
  const s = STATUS_META[status] ?? STATUS_META.planned;
  return badge(s.label, s.tone);
}

export function checkBadge(status) {
  const c = CHECK_META[status] ?? CHECK_META.pending;
  return badge(c.label, c.tone);
}

export function roleBadge(role, label) {
  const r = ROLE_META[role] ?? ROLE_META.member;
  return badge(label ?? r.label, r.tone);
}

export function teamChip(team, { clickable = true } = {}) {
  if (!team) return el('span.text-mute', {}, '—');
  const color = team.color || '#6366f1';
  const node = el(`.team-chip${clickable ? ' is-link' : ''}`, {
    style: { '--team-color': color, background: alpha(color, 0.12), color: color },
  }, el('span.team-dot', { style: { background: color } }),
  el('span', {}, team.name || `Команда №${team.number}`));
  return node;
}

/* ──────────────────── состояния и заглушки ──────────────────── */

export function empty({ icon = '📭', title = 'Пока пусто', text = '', action = null }) {
  return el('.empty', {},
    el('.empty-ico', {}, icon),
    el('h3', {}, title),
    text ? el('p.text-mute', {}, text) : null,
    action,
  );
}

export function errorBox(err, retry) {
  return el('.error-box', {},
    el('.empty-ico', {}, '⚠️'),
    el('h3', {}, 'Не удалось загрузить данные'),
    el('p.text-mute.err-text', {}, err?.message ?? 'Попробуйте обновить страницу'),
    retry ? el('button.btn.btn-soft', { type: 'button', onclick: retry }, 'Повторить') : null,
  );
}

export function loadingBlock(label = 'Загрузка…') {
  return el('.loading-block', {},
    el('.spinner', {}),
    el('span.text-mute', {}, label),
  );
}

export function skeletonCards(n = 3) {
  return el('.grid.grid-3', {},
    Array.from({ length: n }, () => el('.card.skel-card', {},
      el('.skel.skel-circle'),
      el('.skel.skel-text', { style: { width: '60%' } }),
      el('.skel.skel-text', { style: { width: '35%' } }),
    )),
  );
}

export function infoBox(text, tone = 'info') {
  return el(`.${tone === 'info' ? 'info' : tone === 'warn' ? 'warn' : 'ok'}-box`, {}, text);
}

/* ────────────────────── кнопка с загрузкой ────────────────────── */

/** Превращает кнопку в spinner на время await и возвращает исходное состояние. */
export async function withBusy(button, fn) {
  if (button.dataset.busy === '1') return undefined;
  const original = button.innerHTML;
  button.dataset.busy = '1';
  button.disabled = true;
  button.classList.add('is-busy');
  mount(button, el('span.spinner.spinner-sm'), el('span', {}, 'Сохранение…'));
  try {
    return await fn();
  } finally {
    delete button.dataset.busy;
    button.disabled = false;
    button.classList.remove('is-busy');
    button.innerHTML = original;
  }
}

/* ────────────────────── изображения ────────────────────── */

/** Ленивая загрузка защищённого изображения с placeholder-ом. */
export function protectedImage(url, alt = '', { className = '' } = {}) {
  return el(`img${className ? `.${className}` : ''}`, {
    src: url,
    alt,
    loading: 'lazy',
    decoding: 'async',
    onerror: (e) => { e.target.replaceWith(el('.photo-frame.is-missing', {}, '🖼')); },
  });
}

export function photoCardMeta(photo) {
  return el('.photo-meta', {},
    el('div.photo-meta-row', {},
      photo.team ? teamChip(photo.team) : el('span.text-mute', {}, 'Без команды'),
    ),
    el('.photo-meta-row.text-xs.text-soft', {},
      el('span', {}, shortish(photo.date)),
      photo.size ? el('span', {}, '·') : null,
      photo.size ? el('span', {}, fileSize(photo.size)) : null,
    ),
    photo.uploadedBy?.fullName
      ? el('.photo-meta-row.text-xs.text-mute', {}, `Загрузил: ${photo.uploadedBy.fullName}`)
      : null,
  );
}

function shortish(date) {
  if (!date) return '';
  const [, m, d] = date.split('-');
  return `${d}.${m}.${date.slice(0, 4)}`;
}

/* ────────────────────── лайтбокс фотографий ────────────────────── */

export function openLightbox(photos, startIndex = 0) {
  if (!photos?.length) return;
  let index = Math.max(0, Math.min(startIndex, photos.length - 1));
  const img = el('img.lightbox-img', { alt: '' });
  const caption = el('.lightbox-foot');
  const counter = el('span.text-sm.text-mute');

  const render = () => {
    const p = photos[index];
    img.src = p.url;
    img.alt = p.originalName ?? 'Фотография дежурства';
    counter.textContent = `${index + 1} / ${photos.length}`;
    mount(caption,
      el('.row-between.gap-1', {},
        el('div', {},
          el('.fw-600', {}, p.team?.name ?? 'Дежурство'),
          el('.text-xs.text-mute', {}, [p.date, p.uploadedBy?.fullName].filter(Boolean).join(' · ')),
        ),
        counter,
      ),
    );
  };
  const step = (d) => { index = (index + d + photos.length) % photos.length; render(); };

  const dialog = el('.lightbox', {},
    el('button.lightbox-close', { type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, '×'),
    photos.length > 1 ? el('button.lightbox-nav.prev', { type: 'button', 'aria-label': 'Назад', onclick: () => step(-1) }, '‹') : null,
    el('.lightbox-stage', {}, img),
    photos.length > 1 ? el('button.lightbox-nav.next', { type: 'button', 'aria-label': 'Вперёд', onclick: () => step(1) }, '›') : null,
    el('.lightbox-bar', {}, caption),
  );

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  }
  // Клик по фону (не по самой фотографии) закрывает просмотр.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.classList.contains('lightbox-stage')) close();
  });

  function close() {
    document.removeEventListener('keydown', onKey);
    dialog.remove();
    if (document.body.style.overflow === 'hidden') document.body.style.overflow = '';
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(dialog);
  document.body.style.overflow = 'hidden';
  render();
}

/* ────────────────────── сегменты и фильтры ────────────────────── */

export function segment(options, value, onChange, { counts = {} } = {}) {
  const wrap = el('.segment', { role: 'tablist' });
  const paint = (v) => {
    for (const b of wrap.children) {
      const active = b.dataset.value === String(v);
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
  };
  for (const o of options) {
    const count = counts[o.value];
    wrap.appendChild(el('button.seg-btn', {
      type: 'button', role: 'tab', dataset: { value: o.value },
      onclick: () => { paint(o.value); onChange(o.value); },
    }, el('span', {}, o.label), count !== undefined ? el('span.seg-count', {}, String(count)) : null));
  }
  paint(value);
  return wrap;
}

export function field(label, control, { hint = '', required = false } = {}) {
  return el('.field', {},
    label ? el('label.label', {}, label, required ? el('span', { style: { color: 'var(--rose-500)' } }, ' *') : null) : null,
    control,
    hint ? el('.hint', {}, hint) : null,
  );
}

export function selectField(label, options, value, props = {}) {
  return field(label, el('select.select', props, options.map((o) => el('option', {
    value: o.value,
    selected: String(o.value) === String(value ?? ''),
  }, o.label))), { required: props.required });
}

export function timeAgoLabel(iso) { return timeAgo(iso); }

/* Утилита для повторного использования: очистить узел. */
export { clear };
