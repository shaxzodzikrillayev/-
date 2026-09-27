/**
 * Команды: просмотр, карточки, состав, назначение ответственного.
 * Изменение состава и назначение ответственного — только староста.
 */
import express from 'express';
import { q, transaction, audit, getSetting } from '../db.js';
import { requireAuth, requirePermission, clientIp } from '../middleware.js';
import {
  publicUser, teamPublic, str, int, bad, notFound, forbidden, HttpError, todayStr, addDays, DUTY_SELECT, dutyPublic, startOfWeek,
} from '../util.js';
import { isManager, can, leadsTeam, ROLES } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

/* GET /api/teams — все команды (нужны всем авторизованным) */
router.get('/', requirePermission('team.view.all'), (req, res) => {
  const teams = q.all('SELECT * FROM teams ORDER BY number');
  const dutyCount = (id) => q.get('SELECT COUNT(*) AS c FROM duties WHERE team_id = ?', id).c;
  const doneCount = (id) => q.get("SELECT COUNT(*) AS c FROM duties WHERE team_id = ? AND status = 'done'", id).c;
  res.json({
    teams: teams.map((t) => teamPublic(t, {
      dutyCount: dutyCount(t.id),
      doneCount: doneCount(t.id),
      isMyTeam: leadsTeam(req.user, t.id) || req.user.team_id === t.id,
    })),
  });
});

/* GET /api/teams/mine — команда текущего пользователя + история */
router.get('/mine', (req, res) => {
  const u = req.user;
  let team = null;
  if (u.team_id) team = q.get('SELECT * FROM teams WHERE id = ?', u.team_id);
  else {
    const led = q.get('SELECT * FROM teams WHERE responsible_id = ?', u.id);
    team = led ?? null;
  }
  if (!team) {
    return res.json({ team: null, isResponsible: false, members: [], upcoming: [], history: [] });
  }
  const isResponsible = team.responsible_id === u.id;
  const full = teamPublic(team);
  const today = todayStr();
  const upcoming = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date >= ? ORDER BY d.date ASC LIMIT 10`,
    team.id, today,
  ).map((d) => dutyPublic(d, {
    myMark: q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, u.id)?.mark ?? 'unmarked',
  }));
  const history = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date < ? ORDER BY d.date DESC LIMIT 40`,
    team.id, today,
  ).map((d) => dutyPublic(d, {
    myMark: q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, u.id)?.mark ?? 'unmarked',
  }));
  res.json({
    team: full,
    members: full.members,
    memberCount: full.memberCount,
    isResponsible,
    canManage: isManager(u) || isResponsible,
    upcoming,
    history,
  });
});

/* GET /api/teams/:id */
router.get('/:id(\\d+)', requirePermission('team.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Команда', { min: 1 });
  const team = q.get('SELECT * FROM teams WHERE id = ?', id);
  if (!team) return next(notFound('Команда не найдена'));

  const isResponsible = team.responsible_id === req.user.id;
  const canManage = isManager(req.user) || isResponsible;
  const today = todayStr();
  const weekStart = startOfWeek(today);

  const upcoming = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date >= ? ORDER BY d.date ASC LIMIT 15`,
    team.id, today,
  ).map(dutyPublic);
  const history = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date < ? ORDER BY d.date DESC LIMIT 30`,
    team.id, today,
  ).map((d) => dutyPublic(d, {
    marks: teamMarks(d.id, team.id),
  }));
  const marks = teamMarks(q.get('SELECT id FROM duties WHERE team_id = ? AND date = ?', team.id, today)?.id, team.id);
  const todayDuty = q.get(`${DUTY_SELECT} WHERE d.team_id = ? AND d.date = ?`, team.id, today);
  const weekDuties = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date >= ? AND d.date <= ? ORDER BY d.date`,
    team.id, weekStart, addDays(weekStart, 6),
  ).map(dutyPublic);

  res.json({
    team: teamPublic(team),
    viewer: { isResponsible, isManager: isManager(req.user), canManage },
    todayDuty: todayDuty ? { ...dutyPublic(todayDuty), marks } : null,
    upcoming,
    history,
    week: weekDuties,
    stats: teamStats(team.id),
  });
});

function teamMarks(dutyId, teamId) {
  if (!dutyId) return [];
  const rows = q.all(
    `SELECT dm.*, u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
     FROM duty_marks dm
     JOIN users u ON u.id = dm.user_id
     LEFT JOIN teams t ON t.id = u.team_id
     WHERE dm.duty_id = ? ORDER BY u.last_name, u.first_name`, dutyId,
  );
  return rows.map((r) => ({ ...publicUser(r), mark: r.mark, markLabel: MARK_LABEL[r.mark], note: r.note, updatedAt: r.updated_at }));
}
const MARK_LABEL = {
  present: 'Присутствовал', absent: 'Отсутствовал', unmarked: 'Не отмечен',
  served: 'Дежурил', not_served: 'Не дежурил',
};

function teamStats(teamId) {
  const total = q.get(
    `SELECT COUNT(*) AS c FROM duty_marks dm
     JOIN duties d ON d.id = dm.duty_id WHERE d.team_id = ?`, teamId,
  ).c;
  const served = q.get(
    `SELECT COUNT(*) AS c FROM duty_marks dm
     JOIN duties d ON d.id = dm.duty_id WHERE d.team_id = ? AND dm.mark = 'served'`, teamId,
  ).c;
  const absent = q.get(
    `SELECT COUNT(*) AS c FROM duty_marks dm
     JOIN duties d ON d.id = dm.duty_id WHERE d.team_id = ? AND dm.mark = 'absent'`, teamId,
  ).c;
  const duties = q.get('SELECT COUNT(*) AS c FROM duties WHERE team_id = ?', teamId).c;
  const done = q.get("SELECT COUNT(*) AS c FROM duties WHERE team_id = ? AND status = 'done'", teamId).c;
  return {
    totalMarks: total,
    served, absent, duties, done,
    rate: duties ? Math.round((done / duties) * 100) : 0,
    memberRate: total ? Math.round((served / total) * 100) : 0,
  };
}

/* POST /api/teams — новая команда (только староста) */
router.post('/', requirePermission('team.edit'), (req, res, next) => {
  try {
    const number = int(req.body.number, 'Номер команды', { min: 1, max: 99 });
    const name = str(req.body.name ?? `Команда №${number}`, 'Название', { min: 3, max: 60 });
    const color = /^#[0-9a-fA-F]{6}$/.test(String(req.body.color ?? '')) ? String(req.body.color) : '#6366f1';
    if (q.get('SELECT id FROM teams WHERE number = ?', number)) {
      throw new HttpError(409, `Команда №${number} уже существует`, 'CONFLICT');
    }
    const ts = new Date().toISOString();
    const r = q.run(
      'INSERT INTO teams (number, name, color, responsible_id, created_at, updated_at) VALUES (?,?,?,NULL,?,?)',
      number, name, color, ts, ts,
    );
    const id = Number(r.lastInsertRowid);
    audit(req.user.id, 'team.create', 'team', id, { number, name }, clientIp(req));
    res.status(201).json({ team: teamPublic(q.get('SELECT * FROM teams WHERE id = ?', id)) });
  } catch (err) { next(err); }
});

/* PATCH /api/teams/:id — правка названия/цвета/номера */
router.patch('/:id(\\d+)', requirePermission('team.edit'), (req, res, next) => {
  try {
    const id = int(req.params.id, 'Команда', { min: 1 });
    const team = q.get('SELECT * FROM teams WHERE id = ?', id);
    if (!team) throw notFound('Команда не найдена');
    const number = req.body.number === undefined ? team.number : int(req.body.number, 'Номер команды', { min: 1, max: 99 });
    if (number !== team.number && q.get('SELECT id FROM teams WHERE number = ?', number)) {
      throw new HttpError(409, `Команда №${number} уже существует`, 'CONFLICT');
    }
    const name = str(req.body.name ?? team.name, 'Название', { min: 3, max: 60 });
    const color = /^#[0-9a-fA-F]{6}$/.test(String(req.body.color ?? team.color)) ? String(req.body.color) : team.color;
    q.run(
      'UPDATE teams SET number = ?, name = ?, color = ?, updated_at = ? WHERE id = ?',
      number, name, color, new Date().toISOString(), id,
    );
    audit(req.user.id, 'team.update', 'team', id, { number, name }, clientIp(req));
    res.json({ team: teamPublic(q.get('SELECT * FROM teams WHERE id = ?', id)) });
  } catch (err) { next(err); }
});

/* PUT /api/teams/:id/responsible — назначить ответственного */
router.put('/:id(\\d+)/responsible', requirePermission('team.assign'), (req, res, next) => {
  try {
    const id = int(req.params.id, 'Команда', { min: 1 });
    const team = q.get('SELECT * FROM teams WHERE id = ?', id);
    if (!team) throw notFound('Команда не найдена');
    const userId = int(req.body.userId, 'Ответственный', { min: 1, required: false });

    if (userId === null) {
      q.run('UPDATE teams SET responsible_id = NULL, updated_at = ? WHERE id = ?', new Date().toISOString(), id);
      audit(req.user.id, 'team.responsible.clear', 'team', id, {}, clientIp(req));
      return res.json({ team: teamPublic(q.get('SELECT * FROM teams WHERE id = ?', id)) });
    }

    const user = q.get('SELECT * FROM users WHERE id = ?', userId);
    if (!user) throw notFound('Пользователь не найден');
    if (user.is_active === 0) throw bad('Нельзя назначить заблокированного пользователя', 'VALIDATION');
    if (user.role === ROLES.starosta || user.role === ROLES.curator) {
      throw bad('Староста или куратор не может быть ответственным команды', 'VALIDATION');
    }
    // освобождаем прежнего ответственного этой команды в других командах
    q.run('UPDATE teams SET responsible_id = NULL, updated_at = ? WHERE responsible_id = ?', new Date().toISOString(), userId);
    q.run('UPDATE teams SET responsible_id = ?, updated_at = ? WHERE id = ?', userId, new Date().toISOString(), id);
    q.run('UPDATE users SET team_id = ?, updated_at = ? WHERE id = ?', id, new Date().toISOString(), userId);
    q.run(
      `INSERT INTO team_members (team_id, user_id, position, created_at) VALUES (?,?,0,?)
       ON CONFLICT(team_id, user_id) DO NOTHING`,
      id, userId, new Date().toISOString(),
    );
    // будущие дежурства команды закрепляем за новым ответственным
    q.run(
      `UPDATE duties SET responsible_id = ?, updated_at = ?
       WHERE team_id = ? AND date >= ? AND status = 'planned'`,
      userId, new Date().toISOString(), id, todayStr(),
    );
    audit(req.user.id, 'team.responsible.assign', 'team', id, { userId }, clientIp(req));
    return res.json({ team: teamPublic(q.get('SELECT * FROM teams WHERE id = ?', id)) });
  } catch (err) { return next(err); }
});

/* PUT /api/teams/:id/members — изменить состав */
router.put('/:id(\\d+)/members', requirePermission('team.members'), (req, res, next) => {
  try {
    const id = int(req.params.id, 'Команда', { min: 1 });
    const team = q.get('SELECT * FROM teams WHERE id = ?', id);
    if (!team) throw notFound('Команда не найдена');
    if (!isManager(req.user)) throw forbidden('Менять состав может только староста или куратор');
    const raw = Array.isArray(req.body.memberIds) ? req.body.memberIds : [];
    const ids = [...new Set(raw.map((x) => int(x, 'Участник', { min: 1 })))];
    const today = todayStr();
    transaction(() => {
      q.run('DELETE FROM team_members WHERE team_id = ?', id);
      ids.forEach((uid, i) => {
        if (!q.get('SELECT id FROM users WHERE id = ?', uid)) return;
        q.run(
          'INSERT INTO team_members (team_id, user_id, position, created_at) VALUES (?,?,?,?)',
          id, uid, i, new Date().toISOString(),
        );
      });
      // синхронизируем users.team_id с составом
      q.run('UPDATE users SET team_id = NULL, updated_at = ? WHERE team_id = ?', new Date().toISOString(), id);
      if (ids.length) {
        const marks = ids.map(() => '?').join(',');
        q.run(`UPDATE users SET team_id = ?, updated_at = ? WHERE id IN (${marks})`, id, new Date().toISOString(), ...ids);
      }
      // если ответственный выпал из состава — очищаем назначение
      if (team.responsible_id && !ids.includes(team.responsible_id)) {
        q.run('UPDATE teams SET responsible_id = NULL, updated_at = ? WHERE id = ?', new Date().toISOString(), id);
      }
    });
    audit(req.user.id, 'team.members.set', 'team', id, { count: ids.length }, clientIp(req));
    return res.json({ team: teamPublic(q.get('SELECT * FROM teams WHERE id = ?', id)) });
  } catch (err) { return next(err); }
});

/* GET /api/teams/:id/duties */
router.get('/:id(\\d+)/duties', requirePermission('team.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Команда', { min: 1 });
  const from = req.query.from ? str(req.query.from, 'from', { max: 10 }) : todayStr();
  const to = req.query.to ? str(req.query.to, 'to', { max: 10 }) : addDays(from, 90);
  const rows = q.all(
    `${DUTY_SELECT} WHERE d.team_id = ? AND d.date BETWEEN ? AND ? ORDER BY d.date`,
    id, from, to,
  );
  res.json({ duties: rows.map(dutyPublic) });
});

export default router;
