/** Галерея фотографий дежурств с фильтрами и проверкой куратором. */
import { el, fileSize, debounce, plural } from '../lib/dom.js';
import { photosApi, dutiesApi } from '../lib/api.js';
import { state, can } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  badge, checkBadge, teamChip, empty, segment, protectedImage, openLightbox,
  err, ok, warn, confirmDialog, modal, field, withBusy, CHECK_META,
} from '../lib/ui.js';

const SCOPES = [
  { value: 'all', label: 'Все' },
  { value: 'mineTeam', label: 'Моя команда' },
  { value: 'mine', label: 'Мои' },
  { value: 'pending', label: 'На проверке' },
];

export async function photosPage(ctx) {
  const filters = {
    scope: ctx.query.scope ?? 'all',
    check: ctx.query.check ?? '',
    teamId: ctx.query.teamId ?? '',
  };

  const wrap = el('.page.page-enter');
  const gridBox = el('.photo-grid');
  const countBox = el('p.text-sm.text-mute');
  const statsBox = el('.grid.grid-4', { style: { marginBottom: '16px' } });

  const scopeSeg = segment(SCOPES, filters.scope, (v) => { filters.scope = v; load(); });
  const checkSel = el('select.select', { onchange: () => { filters.check = checkSel.value; load(); } },
    el('option', { value: '' }, 'Любая проверка'),
    Object.entries(CHECK_META).map(([k, m]) => el('option', { value: k, selected: k === filters.check }, m.label)));
  const teamSel = el('select.select', { onchange: () => { filters.teamId = teamSel.value; load(); } },
    el('option', { value: '' }, 'Все команды'),
    state.teams.map((t) => el('option', { value: t.id, selected: String(t.id) === String(filters.teamId) }, `№${t.number}`)));

  wrap.appendChild(el('.page-head', {},
    el('div', {}, el('h1.page-title', {}, 'Фотографии'), countBox),
    el('.page-actions', {},
      can('photo.upload') ? el('button.btn.btn-primary', { type: 'button', onclick: () => openUpload() }, '＋ Загрузить') : null,
    ),
  ));
  wrap.appendChild(statsBox);
  wrap.appendChild(el('.card.card-pad', { style: { marginBottom: '16px' } },
    el('.row.row-wrap.gap-1', { style: { marginBottom: '12px' } }, scopeSeg),
    el('.row.row-wrap.gap-1', {}, checkSel, teamSel),
  ));
  wrap.appendChild(gridBox);

  let photos = [];

  async function load() {
    const params = { scope: filters.scope };
    if (filters.check) params.check = filters.check;
    if (filters.teamId) params.teamId = filters.teamId;

    const data = await photosApi.list(params);
    photos = data.photos ?? [];
    const s = data.stats ?? {};
    countBox.textContent = `${photos.length} ${plural(photos.length, 'фотография', 'фотографии', 'фотографий')}`;

    statsBox.replaceChildren(
      stat('📷', s.total ?? 0, 'всего доступно', 'brand'),
      stat('⏳', s.pending ?? 0, 'на проверке', 'amber'),
      stat('✅', s.approved ?? 0, 'подтверждено', 'mint'),
      stat('🚫', s.rejected ?? 0, 'отклонено', 'rose'),
    );

    gridBox.replaceChildren(...(photos.length
      ? photos.map((p, i) => photoCard(p, i))
      : [el('.card', { style: { gridColumn: '1 / -1' } }, empty({
        icon: '📷',
        title: 'Фотографий нет',
        text: 'Здесь появятся фотоотчёты, загруженные участниками команд.',
      }))]));
  }

  function stat(icon, value, label, tone) {
    return el(`.stat.tone-${tone}`, {},
      el('.stat-icon', {}, icon),
      el('div.grow', {}, el('.stat-value', {}, String(value)), el('.stat-label', {}, label)),
    );
  }

  function photoCard(p, index) {
    const st = CHECK_META[p.checkStatus] ?? CHECK_META.pending;
    const toneColor = { success: 'mint', danger: 'rose', warning: 'amber' }[st.tone] ?? 'amber';
    return el('.photo-card', {},
      el('.photo-frame', { onclick: () => openLightbox(photos, index) },
        protectedImage(p.url, p.originalName ?? 'Фото'),
        el('.photo-status', { style: { color: `var(--${toneColor}-600)` } }, st.label),
      ),
      el('.photo-meta', {},
        el('.photo-meta-row', {},
          p.team ? teamChip(p.team, { clickable: false }) : el('span.text-xs.text-mute', {}, '—'),
        ),
        el('.photo-meta-row.text-xs.text-soft', {},
          el('span', {}, p.date ?? ''),
          p.size ? el('span', {}, '·') : null,
          p.size ? el('span', {}, fileSize(p.size)) : null,
        ),
        p.uploadedBy?.fullName
          ? el('.photo-meta-row.text-xs.text-mute', {}, `${p.uploadedBy.fullName}`)
          : null,
        p.reviewNote ? el('.photo-meta-row.text-xs.text-soft', {}, `💬 ${p.reviewNote}`) : null,
        el('.row.row-actions', { style: { marginTop: '8px' } },
          el('a.btn.btn-xs.btn-ghost', {
            href: `#/duties/${p.dutyId}`,
            onclick: (e) => { e.preventDefault(); navigate(`/duties/${p.dutyId}`); },
          }, 'Дежурство'),
          can('photo.review')
            ? el('button.btn.btn-xs.btn-success', { type: 'button', onclick: () => review(p.id, 'approved') }, '✓ Ок')
            : null,
          can('photo.review')
            ? el('button.btn.btn-xs.btn-danger', { type: 'button', onclick: () => review(p.id, 'rejected') }, '✕ Отклонить')
            : null,
          (p.uploadedBy?.id === state.user?.id || can('photo.delete'))
            ? el('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: () => remove(p.id) }, '🗑')
            : null,
        ),
      ),
    );
  }

  async function review(id, status) {
    try {
      await photosApi.review(id, status);
      ok(status === 'approved' ? 'Фото подтверждено' : 'Фото отклонено');
      load();
    } catch (error) { err(error.message); }
  }

  async function remove(id) {
    const yes = await confirmDialog({ title: 'Удалить фото?', text: 'Файл будет удалён с сервера.', confirmText: 'Удалить', danger: true });
    if (!yes) return;
    try { await photosApi.remove(id); ok('Фото удалено'); load(); }
    catch (error) { err(error.message); }
  }

  async function openUpload() {
    const duty = el('select.select', { required: true }, el('option', { value: '' }, '— выберите дежурство —'));
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', required: true });
    const box = el('.uploader', {},
      input,
      el('.uploader-preview', {},
        el('span', {}, '📷'),
        el('span.uploader-hint', {}, 'Выберите фотографию'),
        el('span.text-xs.text-mute', {}, 'JPEG, PNG или WebP, до 12 МБ'),
      ),
    );
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      box.querySelector('.uploader-hint').textContent = f ? f.name : 'Выберите фотографию';
      box.classList.toggle('has-file', Boolean(f));
    });

    // Загружаем только дежурства, которые пользователь вправе вести.
    try {
      const { duties } = await dutiesApi.list({ scope: 'upcoming' });
      const past = await dutiesApi.list({ scope: 'past' });
      for (const d of [...(duties ?? []), ...(past ?? []).slice(0, 30)]) {
        if (!d.canManage) continue;
        duty.appendChild(el('option', { value: d.id }, `${d.date} · команда №${d.teamNumber}`));
      }
    } catch { /* покажем пустой список */ }

    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Загрузить');
    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const file = input.files?.[0];
        if (!file) { warn('Выберите файл'); return; }
        if (!duty.value) { warn('Выберите дежурство'); return; }
        await withBusy(submit, async () => {
          try {
            await photosApi.upload(Number(duty.value), file);
            ok('Фото загружено и отправлено на проверку');
            m.close();
            load();
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Дежурство', duty, { required: true }),
    el('div', { style: { marginTop: '12px' } }, box),
    submit,
    );
    const m = modal({ title: 'Загрузить фотографию', body: form, size: 'sm' });
  }

  await load();
  return wrap;
}
