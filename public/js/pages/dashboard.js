/** Главная: сводка по роли — старосте/куратору, ответственному или ученику. */
import { el, humanDate, todayStr, shortDate, dateLabel } from '../lib/dom.js';
import { statsApi } from '../lib/api.js';
import { state, can, isManager } from '../lib/store.js';
import { navigate } from '../lib/router.js';
import {
  avatar, avatarStack, badge, statusBadge, markBadge, teamChip, empty, errorBox,
  protectedImage, timeAgoLabel,
} from '../lib/ui.js';

function statCard(icon, value, label, tone = 'brand', onClick = null) {
  const node = el(`.stat.tone-${tone}`, onClick ? { role: 'button', tabindex: 0, onclick: onClick, style: { cursor: 'pointer' } } : {},
    el('.stat-icon', {}, icon),
    el('div.grow', {},
      el('.stat-value', {}, String(value ?? 0)),
      el('.stat-label', {}, label),
    ),
  );
  if (onClick) node.addEventListener('keydown', (e) => { if (e.key === 'Enter') onClick(e); });
  return node;
}

function dutyRow(duty, { onClick, right = null } = {}) {
  return el(`.duty-card${duty.isToday ? '.is-today' : ''}`, {
    style: { '--team-color': duty.teamColor ?? '#6366f1' },
    role: onClick ? 'button' : null, tabindex: onClick ? 0 : null,
    onclick: onClick ?? null,
    onkeydown: onClick ? (e) => { if (e.key === 'Enter') onClick(e); } : null,
  },
  el('.duty-date', {},
    el('span.d', {}, String(Number(duty.date?.slice(8, 10) ?? 0))),
    el('span.m', {}, duty.date ? shortDate(duty.date).slice(3) : ''),
  ),
  el('div.grow', {},
    el('.row-between.gap-1', {},
      el('div', { style: { minWidth: 0 } },
        teamChip(duty, { clickable: false }),
        el('.text-sm.text-mute.mt-0', {}, `${dateLabel(duty.date)}${duty.dutyTime ? ` · ${duty.dutyTime}` : ''}`),
      ),
      el('.row.row-actions', {},
        right ?? statusBadge(duty.status),
        duty.photoCount ? el('span.text-xs.text-mute.nowrap', {}, `📷 ${duty.photoCount}`) : null,
      ),
    ),
  ),
  );
}

export async function dashboardPage() {
  const data = await statsApi.overview();
  const c = data.counters ?? {};
  const wrap = el('.page.page-enter');

  /* ─────────── приветствие и ближайшее дежурство ─────────── */
  const firstName = state.user?.firstName ?? 'друг';
  const hour = new Date().getHours();
  const hello = hour < 5 ? 'Доброй ночи' : hour < 12 ? 'Доброе утро' : hour < 18 ? 'Добрый день' : 'Добрый вечер';

  const next = data.nextDuty;
  wrap.appendChild(el('.page-head', {},
    el('div', {},
      el('h1.page-title', {}, `${hello}, ${firstName}!`),
      el('p.text-mute', {}, `${state.classInfo.name ?? ''} · ${humanDate(data.today)}${state.roleLabel ? ` · вы ${state.roleLabel.toLowerCase()}` : ''}`),
    ),
    el('.page-actions', {},
      can('duty.view.all')
        ? el('button.btn.btn-primary', { type: 'button', onclick: () => navigate('/duties') }, 'Расписание')
        : null,
      can('message.view') && can('message.send')
        ? el('button.btn.btn-soft', { type: 'button', onclick: () => navigate('/messages') }, 'Объявить')
        : null,
    ),
  ));

  if (next) {
    wrap.appendChild(el('.next-duty', { style: { marginBottom: '18px' } },
      el('.grow', {},
        el('.stat-label', {}, 'Ближайшее дежурство'),
        el('.next-duty-date', {}, dateLabel(next.date)),
        el('.next-duty-time', {}, `${teamChip(next, { clickable: false }).textContent} · ${next.dutyTime ?? ''}`),
        next.responsible ? el('.text-xs', { style: { opacity: .9, marginTop: '4px' } },
          `Ответственный: ${next.responsible.fullName}`) : null,
      ),
      el('button.btn', { type: 'button', onclick: () => navigate(`/duties/${next.id}`) }, 'Открыть →'),
    ));
  } else {
    wrap.appendChild(el('.card.card-pad', { style: { marginBottom: '18px' } },
      empty({ icon: '🗓', title: 'Дежурств пока нет', text: 'Расписание ещё не создано. Загляните в раздел «Дежурства».' }),
    ));
  }

  /* ─────────── счётчики ─────────── */
  const counters = isManager()
    ? el('.grid.grid-4', { style: { marginBottom: '18px' } },
      statCard('📋', c.dutiesToday, 'дежурств сегодня', 'brand', () => navigate('/duties?scope=today')),
      statCard('✅', c.doneToday, 'выполнено сегодня', 'mint', () => navigate('/duties?scope=today')),
      statCard('⏳', c.pendingToday, 'ожидают проверки', 'amber', () => navigate('/duties?scope=upcoming')),
      statCard('📸', c.pendingPhotos, 'фото на проверке', 'rose', () => navigate('/photos?check=pending')),
      statCard('🚫', c.missedTotal, 'не выполнено всего', 'rose', () => navigate('/duties?status=missed')),
      statCard('👥', c.students, 'учеников в классе', 'sky', () => navigate('/users')),
      statCard('⭐', c.responsibles, 'команд с ответственным', 'mint', () => navigate('/teams')),
      statCard('🔒', c.blocked, 'заблокировано', 'slate', () => navigate('/users?status=blocked')),
    )
    : el('.grid.grid-4', { style: { marginBottom: '18px' } },
      statCard('📋', c.dutiesToday, 'дежурств сегодня', 'brand', () => navigate('/duties')),
      statCard('✅', c.doneToday, 'выполнено', 'mint'),
      statCard('⏳', c.pendingToday, 'ожидают проверки', 'amber'),
      c.teammates !== undefined
        ? statCard('👥', c.teammates, 'в моей команде', 'sky', () => navigate('/teams'))
        : statCard('⭐', data.myStats?.served ?? 0, 'дежурств мной', 'mint', () => navigate('/profile')),
    );

  wrap.appendChild(counters);

  /* ─────────── две колонки: дежурства + сайдбар ─────────── */
  const left = el('div', { style: { display: 'grid', gap: '18px' } });

  /* сегодняшние дежурства */
  left.appendChild(el('.card', {},
    el('.card-head', {},
      el('h3', {}, 'Дежурства на сегодня'),
      can('duty.view.all') ? el('a.btn.btn-sm.btn-ghost', { href: '#/duties', onclick: (e) => { e.preventDefault(); navigate('/duties'); } }, 'Все →') : null,
    ),
    data.todayDuties?.length
      ? el('.card-body', { style: { display: 'grid', gap: '10px' } },
        data.todayDuties.map((d) => dutyRow(d, { onClick: () => navigate(`/duties/${d.id}`) })))
      : el('.card-body', {}, empty({ icon: '☕', title: 'Сегодня дежурств нет', text: 'Можно отдохнуть.' })),
  ));

  /* моя команда (ответственный) */
  if (data.myTeam?.todayDuty) {
    const t = data.myTeam;
    left.appendChild(el('.card', {},
      el('.card-head', {},
        el('h3', {}, `${t.name} · сегодня`),
        el('.row.gap-1', {},
          statusBadge(t.todayDuty.status),
          el('a.btn.btn-sm.btn-soft', { href: `#/duties/${t.todayDuty.id}`, onclick: (e) => { e.preventDefault(); navigate(`/duties/${t.todayDuty.id}`); } }, 'Отметить'),
        ),
      ),
      el('.card-body', {},
        el('.members-grid', {}, (t.members ?? []).map((m) => el('.member-card', { class: m.id === state.user.id ? 'is-lead' : '' },
          avatar(m, 'sm'),
          el('div.grow', { style: { minWidth: 0 } },
            el('.member-name.truncate', {}, m.shortName || m.fullName),
            el('.text-xs', { class: `tone-${m.markTone ?? 'neutral'}`, style: { color: `var(--${toneVar(m.markTone)})` } }, m.markLabel),
          ),
        ))),
      ),
    ));
  }

  /* мои последние дежурства */
  if (data.myDuties?.length) {
    left.appendChild(el('.card', {},
      el('.card-head', {},
        el('h3', {}, 'Мои дежурства'),
        el('a.btn.btn-sm.btn-ghost', { href: '#/profile', onclick: (e) => { e.preventDefault(); navigate('/profile'); } }, 'Вся история →'),
      ),
      el('.card-body', { style: { display: 'grid', gap: '10px' } },
        data.myDuties.slice(0, 5).map((d) => dutyRow(d, {
          onClick: () => navigate(`/duties/${d.id}`),
          right: markBadge(d.myMark),
        })),
      ),
    ));
  }

  /* месячная статистика для менеджеров */
  if (isManager() && data.monthStats) {
    const ms = data.monthStats;
    const total = Math.max(ms.total, 1);
    const seg = (v, cls) => el(`.bar.is-${cls}`, { style: { height: `${Math.max(4, (v / total) * 100)}%` }, title: `${cls}: ${v}` });
    left.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Статистика месяца')),
      el('.card-body', {},
        el('.bars', {}, [
          ...Array.from({ length: ms.done }, () => seg(0, 'done')),
          ...Array.from({ length: ms.pending }, () => seg(0, 'pending')),
          ...Array.from({ length: ms.missed }, () => seg(0, 'missed')),
          ...Array.from({ length: Math.max(0, ms.total - ms.done - ms.pending - ms.missed) }, () => seg(0, 'planned')),
        ]),
        el('.cal-legend', { style: { marginTop: '12px' } },
          el('.cal-legend-item', {}, el('span.dot.dot-success'), `Выполнено: ${ms.done}`),
          el('.cal-legend-item', {}, el('span.dot.dot-warning'), `На проверке: ${ms.pending}`),
          el('.cal-legend-item', {}, el('span.dot.dot-danger'), `Не выполнено: ${ms.missed}`),
        ),
      ),
    ));
  }

  const right = el('div', { style: { display: 'grid', gap: '18px', alignContent: 'start' } });

  /* мои показатели */
  right.appendChild(el('.card.card-pad', {},
    el('.label', {}, 'Мои отметки'),
    el('.kv', {}, el('span.kv-k', {}, 'Всего дежурств'), el('span.kv-v', {}, data.myStats?.total ?? 0)),
    el('.kv', {}, el('span.kv-k', {}, 'Дежурил'), el('span.kv-v', { style: { color: 'var(--mint-600)' } }, data.myStats?.served ?? 0)),
    el('.kv', {}, el('span.kv-k', {}, 'Не дежурил'), el('span.kv-v', { style: { color: 'var(--amber-600)' } }, data.myStats?.notServed ?? 0)),
    el('.kv', {}, el('span.kv-k', {}, 'Отсутствовал'), el('span.kv-v', { style: { color: 'var(--rose-600)' } }, data.myStats?.absent ?? 0)),
  ));

  /* команды: прогресс */
  if (data.teamStats?.length) {
    right.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Команды')),
      el('.card-body', { style: { display: 'grid', gap: '10px' } },
        data.teamStats.map((t) => el('.member-card', { style: { '--team-color': t.color } },
          el('.team-dot', { style: { background: t.color, width: '12px', height: '12px', borderRadius: '50%', flex: '0 0 12px' } }),
          el('a.grow.truncate', {
            href: `#/teams/${t.id}`, style: { fontWeight: 650, fontSize: '.88rem' },
            onclick: (e) => { e.preventDefault(); navigate(`/teams/${t.id}`); },
          }, `№${t.number} ${t.name.replace(/^Команда №\d+\s*—\s*/, '')}`),
          badge(`${t.rate}%`, t.rate >= 70 ? 'success' : t.rate >= 40 ? 'warning' : 'danger'),
        )),
      ),
    ));
  }

  /* фото недели */
  if (data.recentPhotos?.length) {
    right.appendChild(el('.card', {},
      el('.card-head', {},
        el('h3', {}, 'Последние фото'),
        el('a.btn.btn-sm.btn-ghost', { href: '#/photos', onclick: (e) => { e.preventDefault(); navigate('/photos'); } }, 'Все →'),
      ),
      el('.card-body', {},
        el('.photo-grid', { style: { gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' } },
          data.recentPhotos.map((p) => el('.photo-frame', { style: { borderRadius: '10px', aspectRatio: '1' }, title: `${p.date} · ${p.uploadedBy}` },
            protectedImage(p.url, `Фото ${p.date}`),
          )),
        ),
      ),
    ));
  }

  /* частые пропуски */
  if (data.topAbsences?.length && isManager()) {
    right.appendChild(el('.card', {},
      el('.card-head', {}, el('h3', {}, 'Частые пропуски')),
      el('.card-body', { style: { display: 'grid', gap: '8px' } },
        data.topAbsences.map((u) => el('.member-card', { style: { cursor: 'pointer' }, onclick: () => navigate(`/users/${u.id}`) },
          avatar(u, 'sm'),
          el('div.grow', { style: { minWidth: 0 } },
            el('.member-name.truncate', {}, u.shortName || u.fullName),
            el('.text-xs.text-mute', {}, u.teamName ?? ''),
          ),
          badge(String(u.absences), u.absences > 2 ? 'danger' : 'neutral'),
        )),
      ),
    ));
  }

  /* объявления */
  if (data.notices?.length) {
    right.appendChild(el('.card', {},
      el('.card-head', {},
        el('h3', {}, 'Объявления'),
        el('a.btn.btn-sm.btn-ghost', { href: '#/messages', onclick: (e) => { e.preventDefault(); navigate('/messages'); } }, 'Все →'),
      ),
      el('.card-body', { style: { display: 'grid', gap: '10px' } },
        data.notices.map((n) => el('div', {},
          el('.fw-650', {}, n.title),
          el('.text-xs.text-mute', {}, timeAgoLabel(n.created_at)),
        )),
      ),
    ));
  }

  wrap.appendChild(el('.grid.grid-sidebar', {}, left, right));
  return wrap;
}

function toneVar(tone) {
  return { success: 'mint-600', danger: 'rose-600', warning: 'amber-600', neutral: 'ink-500', brand: 'brand-600' }[tone] ?? 'ink-500';
}
