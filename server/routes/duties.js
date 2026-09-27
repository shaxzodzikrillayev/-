/**
 * Дежурства: расписание, календарь, отметки участников, статусы, комментарии.
 * Все проверки прав — на сервере: canManageDuty() в permissions.js.
 */
import express from 'express';
import { q, transaction, audit, getSetting, toDateStr } from '../db.js';
import { requireAuth, requirePermission, clientIp } from '../middleware.js';
import {
  publicUser, dutyPublic, DUTY_SELECT, str, int, dateStr, inOneOf, notFound, forbidden, bad,
  HttpError, todayStr, addDays, startOfWeek, MARK_META, MARKS, STATUSES, isWeekend, dutyDateLabel,
} from '../util.js';
import { isManager, canManageDuty, leadsTeam, ROLES } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

/* ─────────── GET /api/duties — список с фильтрами ─────────── */
router.get('/', requirePermission('duty.view.all'), (req, res, next) => {
  try {
    const today = todayStr();
    const scope = str(req.query.scope ?? 'all', 'Фильтр', { required: false, max: 20 });
    let from = req.query.from ? dateStr(req.query.from, 'Дата «с»') : null;
    let to = req.query.to ? dateStr(req.query.to, 'Дата «до»') : null;

    if (scope === 'today') { from = today; to = today; }
    else if (scope === 'week') { from = startOfWeek(today); to = addDays(from, 6); }
    else if (scope === 'next_week') { const s = addDays(startOfWeek(today), 7); from = s; to = addDays(s, 6); }
    else if (scope === 'month') { from = `${today.slice(0, 7)}-01`; to = today; }
    else if (scope === 'upcoming') { from = today; to = addDays(today, 60); }
    else if (scope === 'past') { from = '1970-01-01'; to = addDays(today, -1); }

    const teamId = req.query.teamId ? int(req.query.teamId, 'Команда', { min: 1 }) : null;
    const status = req.query.status ? inOneOf(req.query.status, 'Статус', STATUSES) : null;
    const search = str(req.query.q ?? '', 'Поиск', { required: false, max: 60 }).toLowerCase();

    const where = [];
    const params = [];
    if (from) { where.push('d.date >= ?'); params.push(from); }
    if (to) { where.push('d.date <= ?'); params.push(to); }
    if (teamId) { where.push('d.team_id = ?'); params.push(teamId); }
    if (status) { where.push('d.status = ?'); params.push(status); }
    if (search) {
      where.push('(LOWER(t.name) LIKE ? OR LOWER(ru.last_name) LIKE ? OR LOWER(ru.first_name) LIKE ?)');
      const like = `%${search}%`;
      params.push(like, like, like);
    }
    const sql = `${DUTY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${from && !to ? 'd.date ASC' : 'd.date DESC'} LIMIT 400`;
    let rows = q.all(sql, ...params);

    // «Мои дежурства» — команда пользователя
    if (scope === 'mine') {
      const t = req.user.team_id ?? q.get('SELECT id FROM teams WHERE responsible_id = ?', req.user.id)?.id;
      rows = rows.filter((d) => d.team_id === t || d.responsible_id === req.user.id);
    }
    if (scope === 'myDuties') {
      rows = rows.filter((d) => d.responsible_id === req.user.id);
    }

    res.json({
      duties: rows.map((d) => dutyPublic(d, {
        canManage: canManageDuty(req.user, d),
        myMark: q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, req.user.id)?.mark ?? null,
      })),
      range: { from, to, scope },
    });
  } catch (err) { next(err); }
});

/* ─────────── GET /api/duties/calendar — сетка месяца ─────────── */
router.get('/calendar', requirePermission('duty.view.all'), (req, res, next) => {
  try {
    const today = todayStr();
    let month = str(req.query.month ?? today.slice(0, 7), 'Месяц', { required: false, max: 7 });
    if (!/^\d{4}-\d{2}$/.test(month)) month = today.slice(0, 7);
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const last = toDateStr(new Date(y, m, 0));
    const start = startOfWeek(first);
    const end = addDays(startOfWeek(last), 6);
    const rows = q.all(
      `${DUTY_SELECT} WHERE d.date BETWEEN ? AND ? ORDER BY d.date`, start, end,
    ).map((d) => dutyPublic(d, { canManage: canManageDuty(req.user, d) }));
    const teams = q.all('SELECT * FROM teams ORDER BY number');
    res.json({
      month,
      today,
      start,
      end,
      duties: rows,
      teams: teams.map((t) => ({ id: t.id, number: t.number, name: t.name, color: t.color })),
    });
  } catch (err) { next(err); }
});

/* ─────────── GET /api/duties/:id ─────────── */
router.get('/:id(\\d+)', requirePermission('duty.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Дежурство', { min: 1 });
  const d = q.get(`${DUTY_SELECT} WHERE d.id = ?`, id);
  if (!d) return next(notFound('Дежурство не найдено'));

  const canManage = canManageDuty(req.user, d);
  const isParticipant = d.team_id === req.user.team_id || d.responsible_id === req.user.id;
  const members = q.all(
    `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.team_id = ? ORDER BY u.last_name, u.first_name`, d.team_id,
  );
  const marks = new Map(
    q.all('SELECT * FROM duty_marks WHERE duty_id = ?', id).map((m) => [m.user_id, m]),
  );
  const photos = q.all(
    `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.middle_name AS up_middle, u.username AS up_username
     FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
     WHERE p.duty_id = ? ORDER BY p.created_at DESC`, id,
  );
  const canSeePhotos = isManager(req.user) || d.team_id === req.user.team_id || d.responsible_id === req.user.id;
  const myMark = marks.get(req.user.id)?.mark ?? 'unmarked';

  res.json({
    duty: dutyPublic(d, { canManage }),
    viewer: { canManage, isManager: isManager(req.user), isParticipant, isResponsible: d.responsible_id === req.user.id },
    members: members.map((u) => {
      const m = marks.get(u.id);
      return {
        ...publicUser(u),
        mark: m?.mark ?? 'unmarked',
        markLabel: MARK_META[m?.mark ?? 'unmarked'].label,
        markTone: MARK_META[m?.mark ?? 'unmarked'].tone,
        note: m?.note ?? '',
        isLead: u.id === d.responsible_id,
        updatedAt: m?.updated_at ?? null,
      };
    }),
    photos: canSeePhotos ? photos.map(photoPublic) : [],
    photosHidden: !canSeePhotos,
    myMark,
    canUploadPhoto: canManage || d.team_id === req.user.team_id,
  });
});

function photoPublic(p) {
  return {
    id: p.id,
    dutyId: p.duty_id,
    url: `/api/files/photo/${p.id}`,
    originalName: p.original_name,
    mime: p.mime,
    size: p.size,
    date: p.date,
    checkStatus: p.check_status,
    reviewNote: p.review_note,
    uploadedBy: p.uploaded_by
      ? {
        id: p.uploaded_by,
        fullName: `${p.up_last ?? ''} ${p.up_first ?? ''}`.trim(),
        username: p.up_username,
        avatar: `/api/files/avatar/${p.uploaded_by}`,
      }
      : null,
    createdAt: p.created_at,
  };
}
export { photoPublic };

/* ─────────── POST /api/duties — создать (староста/куратор) ─────────── */
router.post('/', requirePermission('duty.create', 'duty.schedule'), (req, res, next) => {
  try {
    const date = dateStr(req.body.date, 'Дата');
    const teamId = int(req.body.teamId, 'Команда', { min: 1 });
    const dutyTime = str(req.body.dutyTime ?? '08:00 – 08:20', 'Время', { max: 60 });
    const status = inOneOf(req.body.status ?? 'planned', 'Статус', STATUSES);
    const team = q.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) throw bad('Команда не найдена', 'VALIDATION');
    if (q.get('SELECT id FROM duties WHERE date = ?', date)) {
      throw new HttpError(409, `На ${date} дежурство уже создано`, 'DUTY_EXISTS');
    }
    const responsibleId = req.body.responsibleId
      ? int(req.body.responsibleId, 'Ответственный', { min: 1 })
      : team.responsible_id;
    const ts = new Date().toISOString();
    const r = q.run(
      `INSERT INTO duties (date, team_id, responsible_id, duty_time, status, comment, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,'',?,?,?)`,
      date, teamId, responsibleId, dutyTime, status, req.user.id, ts, ts,
    );
    const id = Number(r.lastInsertRowid);
    // создаём отметки для всех участников команды
    const members = q.all('SELECT user_id FROM team_members WHERE team_id = ?', teamId);
    for (const m of members) {
      q.run(
        `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
         VALUES (?,?,'unmarked','',?,?) ON CONFLICT(duty_id, user_id) DO NOTHING`,
        id, m.user_id, req.user.id, ts,
      );
    }
    audit(req.user.id, 'duty.create', 'duty', id, { date, teamId }, clientIp(req));
    res.status(201).json({ duty: dutyPublic(q.get(`${DUTY_SELECT} WHERE d.id = ?`, id)) });
  } catch (err) { next(err); }
});

/* ─────────── PATCH /api/duties/:id ─────────── */
router.patch('/:id(\\d+)', requirePermission('duty.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Дежурство', { min: 1 });
  const d = q.get(`${DUTY_SELECT} WHERE d.id = ?`, id);
  if (!d) return next(notFound('Дежурство не найдено'));

  const wantsScheduleChange = req.body.teamId !== undefined || req.body.date !== undefined
    || req.body.dutyTime !== undefined || req.body.responsibleId !== undefined;
  const wantsStatus = req.body.status !== undefined;

  if (wantsScheduleChange && !isManager(req.user)) {
    return next(forbidden('Изменять расписание может только староста или куратор'));
  }
  if (wantsStatus && !canManageDuty(req.user, d)) {
    return next(forbidden('Отметить выполнение может ответственный, куратор или староста'));
  }
  if (req.body.comment !== undefined && !canManageDuty(req.user, d)) {
    return next(forbidden('Комментарий может добавить ответственный, куратор или староста'));
  }

  try {
    const ts = new Date().toISOString();
    const date = req.body.date === undefined ? d.date : dateStr(req.body.date, 'Дата');
    if (date !== d.date && q.get('SELECT id FROM duties WHERE date = ?', date)) {
      throw new HttpError(409, `На ${date} дежурство уже создано`, 'DUTY_EXISTS');
    }
    const teamId = req.body.teamId === undefined ? d.team_id : int(req.body.teamId, 'Команда', { min: 1 });
    const team = q.get('SELECT * FROM teams WHERE id = ?', teamId);
    if (!team) throw bad('Команда не найдена', 'VALIDATION');
    const dutyTime = req.body.dutyTime === undefined ? d.duty_time : str(req.body.dutyTime, 'Время', { max: 60 });
    const responsibleId = req.body.responsibleId === undefined
      ? d.responsible_id
      : (req.body.responsibleId === null ? null : int(req.body.responsibleId, 'Ответственный', { min: 1 }));
    const status = req.body.status === undefined ? d.status : inOneOf(req.body.status, 'Статус', STATUSES);
    const comment = req.body.comment === undefined ? d.comment : str(req.body.comment, 'Комментарий', { required: false, max: 1000 });

    transaction(() => {
      q.run(
        `UPDATE duties SET date = ?, team_id = ?, responsible_id = ?, duty_time = ?, status = ?, comment = ?, updated_at = ?
         WHERE id = ?`,
        date, teamId, responsibleId, dutyTime, status, comment, ts, id,
      );
      if (teamId !== d.team_id) {
        q.run('DELETE FROM duty_marks WHERE duty_id = ?', id);
        const members = q.all('SELECT user_id FROM team_members WHERE team_id = ?', teamId);
        for (const m of members) {
          q.run(
            `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
             VALUES (?,?,'unmarked','',?,?) ON CONFLICT(duty_id, user_id) DO NOTHING`,
            id, m.user_id, req.user.id, ts,
          );
        }
      } else {
        const members = q.all('SELECT user_id FROM team_members WHERE team_id = ?', teamId);
        for (const m of members) {
          q.run(
            `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
             VALUES (?,?,'unmarked','',?,?) ON CONFLICT(duty_id, user_id) DO NOTHING`,
            id, m.user_id, req.user.id, ts,
          );
        }
      }
    });
    audit(req.user.id, 'duty.update', 'duty', id, { date, teamId, status }, clientIp(req));
    const fresh = q.get(`${DUTY_SELECT} WHERE d.id = ?`, id);
    const photos = q.all(
      `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.middle_name AS up_middle, u.username AS up_username
       FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE p.duty_id = ? ORDER BY p.created_at DESC`, id,
    );
    const members = q.all(
      `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
       FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id = ? ORDER BY u.last_name, u.first_name`, teamId,
    );
    const marks = new Map(q.all('SELECT * FROM duty_marks WHERE duty_id = ?', id).map((m) => [m.user_id, m]));
    return res.json({
      duty: dutyPublic(fresh, { canManage: canManageDuty(req.user, fresh) }),
      members: members.map((u) => {
        const m = marks.get(u.id);
        return {
          ...publicUser(u),
          mark: m?.mark ?? 'unmarked',
          markLabel: MARK_META[m?.mark ?? 'unmarked'].label,
          markTone: MARK_META[m?.mark ?? 'unmarked'].tone,
          note: m?.note ?? '',
          isLead: u.id === fresh.responsible_id,
          updatedAt: m?.updated_at ?? null,
        };
      }),
      photos: photos.map(photoPublic),
      myMark: marks.get(req.user.id)?.mark ?? 'unmarked',
    });
  } catch (err) { return next(err); }
});

/* ─────────── PUT /api/duties/:id/marks/:userId — отметка участника ─────── */
router.put('/:id(\\d+)/marks/:userId(\\d+)', requirePermission('duty.view.all'), (req, res, next) => {
  const dutyId = int(req.params.id, 'Дежурство', { min: 1 });
  const userId = int(req.params.userId, 'Ученик', { min: 1 });
  const d = q.get(`${DUTY_SELECT} WHERE d.id = ?`, dutyId);
  if (!d) return next(notFound('Дежурство не найдено'));
  if (!canManageDuty(req.user, d)) {
    return next(forbidden('Отмечать участников может ответственный этой команды, куратор или староста'));
  }
  const member = q.get('SELECT * FROM users WHERE id = ?', userId);
  if (!member) return next(notFound('Ученик не найден'));
  if (member.team_id !== d.team_id && member.id !== d.responsible_id) {
    return next(forbidden('Этот ученик не состоит в команде этого дежурства'));
  }
  try {
    const mark = inOneOf(req.body.mark, 'Отметка', MARKS);
    const note = str(req.body.note ?? '', 'Примечание', { required: false, max: 300 });
    const ts = new Date().toISOString();
    q.run(
      `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(duty_id, user_id) DO UPDATE SET mark = excluded.mark, note = excluded.note,
         updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      dutyId, userId, mark, note, req.user.id, ts,
    );
    // Все отмечены и есть хотя бы один «дежурил» — статус «ожидает проверки»
    const marks = q.all('SELECT mark FROM duty_marks WHERE duty_id = ?', dutyId);
    const allMarked = marks.length > 0 && marks.every((m) => m.mark !== 'unmarked');
    const anyServed = marks.some((m) => m.mark === 'served');
    if (d.status === 'planned' && allMarked && anyServed) {
      q.run("UPDATE duties SET status = 'pending', updated_at = ? WHERE id = ?", ts, dutyId);
    }
    audit(req.user.id, 'duty.mark', 'duty', dutyId, { userId, mark }, clientIp(req));
    return res.json({
      ok: true,
      mark,
      note,
      dutyStatus: q.get('SELECT status FROM duties WHERE id = ?', dutyId).status,
      marks: q.all(
        `SELECT dm.*, u.first_name, u.last_name, u.middle_name, u.username, u.role, u.avatar, u.is_active,
                u.team_id, t.name AS team_name, t.number AS team_number, t.color AS team_color
         FROM duty_marks dm JOIN users u ON u.id = dm.user_id
         LEFT JOIN teams t ON t.id = u.team_id
         WHERE dm.duty_id = ? ORDER BY u.last_name, u.first_name`, dutyId,
      ).map((m) => ({
        ...publicUser(m),
        mark: m.mark,
        markLabel: MARK_META[m.mark].label,
        markTone: MARK_META[m.mark].tone,
        note: m.note,
        updatedAt: m.updated_at,
      })),
    });
  } catch (err) { return next(err); }
});

/* ─────────── POST /api/duties/:id/marks — отметить всех разом ─────── */
router.post('/:id(\\d+)/marks/bulk', requirePermission('duty.view.all'), (req, res, next) => {
  const dutyId = int(req.params.id, 'Дежурство', { min: 1 });
  const d = q.get(`${DUTY_SELECT} WHERE d.id = ?`, dutyId);
  if (!d) return next(notFound('Дежурство не найдено'));
  if (!canManageDuty(req.user, d)) return next(forbidden('Нет прав отмечать участников'));
  try {
    const mark = inOneOf(req.body.mark, 'Отметка', MARKS);
    const only = Array.isArray(req.body.userIds) ? req.body.userIds.map((x) => int(x, 'Ученик', { min: 1 })) : null;
    const members = q.all('SELECT id FROM users WHERE team_id = ?', d.team_id);
    const targets = only ? members.filter((u) => only.includes(u.id)) : members;
    const ts = new Date().toISOString();
    for (const u of targets) {
      q.run(
        `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
         VALUES (?,?,?,'',?,?)
         ON CONFLICT(duty_id, user_id) DO UPDATE SET mark = excluded.mark, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        dutyId, u.id, mark, req.user.id, ts,
      );
    }
    audit(req.user.id, 'duty.mark.bulk', 'duty', dutyId, { mark, count: targets.length }, clientIp(req));
    return res.json({ ok: true, count: targets.length });
  } catch (err) { return next(err); }
});

/* ─────────── DELETE /api/duties/:id (только староста) ─────── */
router.delete('/:id(\\d+)', requirePermission('duty.delete'), (req, res, next) => {
  const id = int(req.params.id, 'Дежурство', { min: 1 });
  const d = q.get('SELECT id FROM duties WHERE id = ?', id);
  if (!d) return next(notFound('Дежурство не найдено'));
  q.run('DELETE FROM duties WHERE id = ?', id);
  audit(req.user.id, 'duty.delete', 'duty', id, {}, clientIp(req));
  return res.json({ ok: true });
});

/* ─────────── GET /api/duties/:id/photos ─────── */
router.get('/:id(\\d+)/photos', requirePermission('duty.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Дежурство', { min: 1 });
  const d = q.get(`${DUTY_SELECT} WHERE d.id = ?`, id);
  if (!d) return next(notFound('Дежурство не найдено'));
  if (!isManager(req.user) && d.team_id !== req.user.team_id && d.responsible_id !== req.user.id) {
    return next(forbidden('Фотографии этого дежурства вам недоступны'));
  }
  const photos = q.all(
    `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.middle_name AS up_middle, u.username AS up_username
     FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE p.duty_id = ? ORDER BY p.created_at DESC`, id,
  );
  return res.json({ photos: photos.map(photoPublic) });
});

/* ─────────── GET /api/duties/my/history — история дежурств пользователя ── */
router.get('/my/history', requirePermission('duty.view.all'), (req, res) => {
  const rows = q.all(
    `${DUTY_SELECT}
     JOIN duty_marks dm ON dm.duty_id = d.id
     WHERE dm.user_id = ? ORDER BY d.date DESC LIMIT 60`, req.user.id,
  );
  const marks = new Map(q.all('SELECT * FROM duty_marks WHERE user_id = ?', req.user.id).map((m) => [m.duty_id, m]));
  const duties = rows.map((d) => {
    const m = marks.get(d.id);
    return { ...dutyPublic(d), myMark: m?.mark ?? 'unmarked', markLabel: MARK_META[m?.mark ?? 'unmarked'].label, markTone: MARK_META[m?.mark ?? 'unmarked'].tone };
  });
  const stats = {
    total: duties.length,
    served: duties.filter((x) => x.myMark === 'served').length,
    absent: duties.filter((x) => x.myMark === 'absent').length,
    notServed: duties.filter((x) => x.myMark === 'not_served').length,
    unmarked: duties.filter((x) => x.myMark === 'unmarked').length,
  };
  res.json({ duties, stats });
});

/* ─────────── GET /api/duties/my/next — ближайшее дежурство ─────── */
router.get('/my/next', requirePermission('duty.view.all'), (req, res) => {
  const teamId = req.user.team_id ?? q.get('SELECT id FROM teams WHERE responsible_id = ?', req.user.id)?.id ?? null;
  const today = todayStr();
  const nextByTeam = teamId
    ? q.get(`${DUTY_SELECT} WHERE d.team_id = ? AND d.date >= ? ORDER BY d.date LIMIT 1`, teamId, today)
    : null;
  const nextByLead = q.get(`${DUTY_SELECT} WHERE d.responsible_id = ? AND d.date >= ? ORDER BY d.date LIMIT 1`, req.user.id, today);
  const chosen = (nextByLead && nextByTeam)
    ? (nextByLead.date <= nextByTeam.date ? nextByLead : nextByTeam)
    : (nextByTeam ?? nextByLead);
  res.json({
    duty: chosen ? dutyPublic(chosen, { canManage: canManageDuty(req.user, chosen) }) : null,
    teamId,
  });
});

export default router;
