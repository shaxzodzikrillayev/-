/** Карточка дежурства: отметки участников, фотографии, комментарий, управление. */
import { el, dateLabel, fileSize, todayStr } from '../lib/dom.js';
import { dutiesApi, photosApi } from '../lib/api.js';
import { state, can, canAny, isStarosta, isManager, leadsTeam } from '../lib/store.js';
import { navigate, reload } from '../lib/router.js';
import {
  avatar, badge, statusBadge, markBadge, checkBadge, teamChip, empty, toast, err, ok, warn,
  confirmDialog, modal, closeModal, field, withBusy, protectedImage, openLightbox,
  timeAgoLabel, MARK_META, MARK_ORDER, STATUS_META, CHECK_META,
} from '../lib/ui.js';

const MARK_BUTTONS = [
  { value: 'served', label: 'Дежурил', tone: 'success' },
  { value: 'present', label: 'Присутствовал', tone: 'neutral' },
  { value: 'not_served', label: 'Не дежурил', tone: 'warning' },
  { value: 'absent', label: 'Отсутствовал', tone: 'danger' },
];

export async function dutyPage(ctx) {
  const id = Number(ctx.params.id);
  const data = await dutiesApi.get(id);
  const { duty, viewer, members, photos, photosHidden, canUploadPhoto } = data;

  const isMyTurn = duty.responsibleId === state.user?.id;
  const canMark = viewer.canManage;

  const wrap = el('.page.page-enter');

  /* ─────────── шапка ─────────── */
  wrap.appendChild(el('.page-head', {},
    el('div', {},
      el('.row.row-wrap.gap-1', { style: { marginBottom: '6px' } },
        el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => history.back() }, '← Назад'),
        statusBadge(duty.status),
        duty.isToday ? badge('Сегодня', 'brand') : null,
        duty.isWeekend ? badge('Выходной', 'neutral') : null,
      ),
      el('h1.page-title', {}, `${duty.teamName ?? `Команда №${duty.teamNumber}`}`),
      el('p.text-mute', {}, `${dateLabel(duty.date)}${duty.dutyTime ? ` · ${duty.dutyTime}` : ''}`),
    ),
    el('.page-actions', {},
      can('photo.upload') && (canMark || isMyTurn)
        ? el('button.btn.btn-soft', { type: 'button', onclick: () => openUpload() }, '📸 Добавить фото')
        : null,
      canAny('duty.schedule') && isManager()
        ? el('button.btn.btn-ghost', { type: 'button', onclick: () => openEdit() }, 'Изменить')
        : null,
      can('duty.delete')
        ? el('button.btn.btn-ghost', { type: 'button', onclick: removeDuty }, 'Удалить')
        : null,
    ),
  ));

  const columns = el('.grid.grid-sidebar');

  /* ═══════════════ левая колонка: участники ═══════════════ */
  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  const markBox = el('.card', {},
    el('.card-head', {},
      el('div', {},
        el('h3', {}, `Участники · ${members.length}`),
        duty.responsible ? el('.text-xs.text-mute', {}, `Ответственный: ${duty.responsible.fullName}`) : null,
      ),
      canMark
        ? el('.row.gap-1', {},
          el('button.btn.btn-sm.btn-soft', { type: 'button', onclick: () => bulkMark('served') }, 'Все «Дежурил»'),
          el('button.btn.btn-sm.btn-ghost', { type: 'button', onclick: () => bulkMark('absent') }, 'Все «Отсутствовал»'),
        )
        : null,
    ),
    el('.card-body', {},
      members.length
        ? el('.mark-grid', {}, members.map((m) => memberCard(m)))
        : empty({ icon: '👥', title: 'В команде пока никого нет', text: 'Добавьте учеников в разделе «Команды».' }),
    ),
  );
  left.appendChild(markBox);

  /* ═══════════════ фотографии ═══════════════ */
  const photoBox = el('.card', {},
    el('.card-head', {},
      el('h3', {}, `Фотографии${photos.length ? ` · ${photos.length}` : ''}`),
      canUploadPhoto
        ? el('button.btn.btn-sm.btn-soft', { type: 'button', onclick: () => openUpload() }, '＋ Загрузить')
        : null,
    ),
    el('.card-body', {},
      photosHidden
        ? el('.info-box', {}, 'Фотографии этого дежурства доступны только команде-дежурному, куратору и старосте.')
        : photos.length
          ? el('.photo-grid', {}, photos.map((p, i) => photoCard(p, i)))
          : empty({
            icon: '📷',
            title: 'Фотографий нет',
            text: canUploadPhoto ? 'Сделайте фотоотчёт после дежурства — прикрепите снимки здесь.' : 'Ответственный может прикрепить фотоотчёт.',
          }),
    ),
  );
  left.appendChild(photoBox);

  columns.appendChild(left);

  /* ═══════════════ правая колонка: сводка ═══════════════ */
  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });

  /* мой статус */
  const myMark = data.myMark ?? 'unmarked';
  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Моя отметка'),
    el('.row.gap-1', { style: { marginTop: '8px' } }, markBadge(myMark)),
    el('.text-xs.text-mute', { style: { marginTop: '6px' } },
      canMark ? 'Вы отвечаете за это дежурство — отметьте участников.' : 'Отметку проставляет ответственный или куратор.'),
  ));

  /* итоги по отметкам */
  const tally = {};
  for (const m of MARK_ORDER) tally[m] = members.filter((x) => x.mark === m).length;
  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Итоги по команде'),
    ...MARK_ORDER.map((k) => el('.kv', {},
      el('span.kv-k', {}, MARK_META[k].label),
      el('span.kv-v', {}, String(tally[k] ?? 0)),
    )),
  ));

  /* смена статуса */
  if (canMark || can('duty.complete')) {
    right.appendChild(el('.card.card-pad', {},
      el('.label', {}, 'Статус дежурства'),
      el('.row.row-wrap.gap-1', { style: { marginTop: '10px' } },
        Object.entries(STATUS_META).map(([key, meta]) => el(`button.btn.btn-sm${duty.status === key ? '.btn-primary' : '.btn-ghost'}`, {
          type: 'button',
          onclick: () => setStatus(key),
        }, meta.label)),
      ),
    ));
  }

  /* комментарий */
  const commentBox = el('textarea.textarea', {
    rows: 3, maxlength: 1000, placeholder: 'Например: кабинет убран, окна закрыты…', value: duty.comment ?? '',
    disabled: !canMark,
  });
  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Комментарий'),
    el('div', { style: { marginTop: '8px' } }, commentBox),
    canMark
      ? el('button.btn.btn-soft.btn-sm', {
        type: 'button', style: { marginTop: '10px' },
        onclick: async (e) => {
          await withBusy(e.currentTarget, async () => {
            try {
              await dutiesApi.update(id, { comment: commentBox.value });
              ok('Комментарий сохранён');
              reload();
            } catch (error) { err(error.message); }
          });
        },
      }, 'Сохранить комментарий')
      : null,
  ));

  /* действия по роли */
  if (canMark && viewer.isResponsible && !isManager()) {
    right.appendChild(el('.info-box', {}, 'Вы — ответственный за это дежурство. После проверки куратор подтвердит выполнение.'));
  }

  columns.appendChild(right);
  wrap.appendChild(columns);

  /* ═══════════════ логика действий ═══════════════ */

  function memberCard(m) {
    const btns = el('.mark-btns');
    for (const b of MARK_BUTTONS) {
      const active = m.mark === b.value;
      btns.appendChild(el(`button.mark-btn${active ? '.is-on' : ''}`, {
        type: 'button',
        disabled: !canMark,
        title: canMark ? b.label : 'Нет прав',
        style: active ? markToneStyle(b.tone) : null,
        onclick: (e) => setMark(m, b.value, e.currentTarget),
      }, b.label));
    }
    return el(`.mark-row${m.isLead ? '.is-lead' : ''}`, { style: m.isLead ? { borderColor: 'var(--brand-300)' } : null },
      avatar(m, 'sm'),
      el('.grow', { style: { minWidth: 0 } },
        el('.row.gap-1', {},
          el('span.member-name.truncate', {}, m.shortName || m.fullName),
          m.isLead ? badge('Ответственный', 'brand') : null,
          m.id === state.user?.id ? badge('Это я', 'info') : null,
        ),
        m.note ? el('.text-xs.text-mute.truncate', {}, `💬 ${m.note}`) : null,
      ),
      btns,
    );
  }

  async function setMark(member, mark, button) {
    if (!canMark) return;
    const note = member.note ?? '';
    button?.classList.add('is-busy');
    try {
      await dutiesApi.mark(id, member.id, mark, note);
      const card = button?.closest('.mark-row');
      for (const b of card?.querySelectorAll('.mark-btn') ?? []) b.classList.remove('is-on');
      button?.classList.add('is-on');
      Object.assign(button?.style ?? {}, markToneStyle(MARK_BUTTONS.find((b) => b.value === mark).tone));
      toast(`${member.shortName}: ${MARK_META[mark].label.toLowerCase()}`, 'success', 1800);
    } catch (error) {
      err(error.message);
    } finally {
      button?.classList.remove('is-busy');
    }
  }

  async function bulkMark(mark) {
    if (!canMark) return;
    const okDo = await confirmDialog({
      title: 'Отметить всех',
      text: `Все участники команды будут отмечены как «${MARK_META[mark].label}». Продолжить?`,
      confirmText: 'Отметить',
    });
    if (!okDo) return;
    try {
      const res = await dutiesApi.markBulk(id, mark, null);
      ok(`Отмечено: ${res.count}`);
      reload();
    } catch (error) { err(error.message); }
  }

  async function setStatus(status) {
    try {
      await dutiesApi.update(id, { status });
      ok(`Статус: ${STATUS_META[status].label}`);
      reload();
    } catch (error) { err(error.message); }
  }

  async function removeDuty() {
    const yes = await confirmDialog({
      title: 'Удалить дежурство?',
      text: 'Дежурство, все отметки и прикреплённые фотографии будут удалены безвозвратно.',
      confirmText: 'Удалить',
      danger: true,
    });
    if (!yes) return;
    try {
      await dutiesApi.remove(id);
      ok('Дежурство удалено');
      navigate('/duties');
    } catch (error) { err(error.message); }
  }

  function openEdit() {
    const date = el('input.input', { type: 'date', value: duty.date, required: true });
    const team = el('select.select', {},
      state.teams.map((t) => el('option', { value: t.id, selected: t.id === duty.teamId }, t.name)));
    const time = el('input.input', { value: duty.dutyTime ?? '', maxlength: 60 });
    const status = el('select.select', {},
      Object.entries(STATUS_META).map(([k, m]) => el('option', { value: k, selected: k === duty.status }, m.label)));
    const submit = el('button.btn.btn-primary', { type: 'submit' }, 'Сохранить');

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        await withBusy(submit, async () => {
          try {
            await dutiesApi.update(id, {
              date: date.value, teamId: team.value, dutyTime: time.value.trim(), status: status.value,
            });
            ok('Дежурство обновлено');
            m.close();
            reload();
          } catch (error) { err(error.message); }
        });
      },
    },
    field('Дата', date, { required: true }),
    field('Команда', team),
    field('Время и место', time),
    field('Статус', status),
    el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '18px' } }, 'Сохранить'),
    );
    const m = modal({ title: 'Изменить дежурство', body: form, size: 'sm' });
  }

  function openUpload() {
    const input = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', required: true });
    const submit = el('button.btn.btn-primary.btn-block', { type: 'submit', style: { marginTop: '16px' } }, 'Загрузить');
    const box = el('.uploader', {},
      input,
      el('.uploader-preview', {},
        el('span', {}, '📷'),
        el('span.uploader-hint', {}, 'Выберите фотографию'),
        el('span.text-xs.text-mute', {}, 'JPEG или PNG, до 12 МБ. Можно прикрепить несколько по одной.'),
      ),
    );
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) box.querySelector('.uploader-hint').textContent = f.name;
      box.classList.toggle('has-file', Boolean(f));
    });

    const form = el('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        const file = input.files?.[0];
        if (!file) { warn('Выберите файл'); return; }
        await withBusy(submit, async () => {
          try {
            await photosApi.upload(id, file);
            ok('Фото загружено и отправлено на проверку');
            m.close();
            reload();
          } catch (error) { err(error.message); }
        });
      },
    }, box, submit);

    const m = modal({ title: 'Фотоотчёт', body: form, size: 'sm' });
  }

  function photoCard(p, index) {
    const status = CHECK_META[p.checkStatus] ?? CHECK_META.pending;
    return el('.photo-card', {},
      el('.photo-frame', { onclick: () => openLightbox(photos, index) },
        protectedImage(p.url, p.originalName ?? 'Фото'),
        el(`.photo-status`, { style: { color: `var(--${status.tone === 'success' ? 'mint' : status.tone === 'danger' ? 'rose' : 'amber'}-600)` } }, status.label),
      ),
      el('.photo-meta', {},
        el('.photo-meta-row', {},
          el('span.text-xs.text-soft', {}, p.date ?? ''),
          p.size ? el('span.text-xs.text-mute', {}, fileSize(p.size)) : null,
        ),
        p.uploadedBy?.fullName ? el('.photo-meta-row.text-xs.text-mute', {}, p.uploadedBy.fullName) : null,
        p.reviewNote ? el('.photo-meta-row.text-xs.text-soft', {}, `💬 ${p.reviewNote}`) : null,
        el('.row.row-actions', { style: { marginTop: '6px' } },
          can('photo.review')
            ? el('button.btn.btn-xs.btn-success', { type: 'button', onclick: () => review(p.id, 'approved') }, '✓')
            : null,
          can('photo.review')
            ? el('button.btn.btn-xs.btn-danger', { type: 'button', onclick: () => review(p.id, 'rejected') }, '✕')
            : null,
          (p.uploadedBy?.id === state.user?.id || can('photo.delete'))
            ? el('button.btn.btn-xs.btn-ghost', { type: 'button', onclick: () => removePhoto(p.id) }, '🗑')
            : null,
        ),
      ),
    );
  }

  async function review(photoId, status) {
    try {
      await photosApi.review(photoId, status);
      ok(status === 'approved' ? 'Фото подтверждено' : 'Фото отклонено');
      reload();
    } catch (error) { err(error.message); }
  }

  async function removePhoto(photoId) {
    const yes = await confirmDialog({ title: 'Удалить фото?', text: 'Файл будет удалён с сервера.', confirmText: 'Удалить', danger: true });
    if (!yes) return;
    try {
      await photosApi.remove(photoId);
      ok('Фото удалено');
      reload();
    } catch (error) { err(error.message); }
  }

  return wrap;
}

function markToneStyle(tone) {
  return {
    success: { background: 'var(--mint-100)', borderColor: 'var(--mint-400)', color: 'var(--mint-700)' },
    danger: { background: 'var(--rose-100)', borderColor: 'var(--rose-400)', color: 'var(--rose-700)' },
    warning: { background: 'var(--amber-100)', borderColor: 'var(--amber-400)', color: 'var(--amber-700)' },
    neutral: { background: 'var(--ink-100)', borderColor: 'var(--ink-300)', color: 'var(--ink-700)' },
  }[tone] ?? {};
}
