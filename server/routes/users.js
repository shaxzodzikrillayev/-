/**
 * Пользователи: каталог, карточка, администрирование (только староста).
 * Никто, кроме старосты, не может менять чужие данные, роли и блокировки.
 * Роль нельзя повысить самостоятельно: promote доступен только внутри
 * защищённого экрана старосты и логируется в audit_log.
 */
import express from 'express';
import { q, transaction, audit } from '../db.js';
import { hashPassword, passwordIssues, verifyPassword } from '../auth-utils.js';
import { requireAuth, requirePermission, destroyAllSessions, clientIp, rateLimit } from '../middleware.js';
import { uploadAvatar, verifyImage, removeAvatar } from '../uploads.js';
import {
  publicUser, str, username as vUsername, personName, int, inOneOf, notFound, bad, conflict,
  HttpError, forbidden, todayStr, DUTY_SELECT, MARK_META,
} from '../util.js';
import { isStarosta, isManager, ROLES, ROLE_LABELS } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

const ALL_ROLES = [ROLES.starosta, ROLES.curator, ROLES.responsible, ROLES.member];

/* ─────────── GET /api/users — каталог с поиском и фильтрами ─────────── */
router.get('/', requirePermission('user.view.all'), (req, res, next) => {
  try {
    const search = str(req.query.q ?? '', 'Поиск', { required: false, max: 60 }).toLowerCase();
    const role = req.query.role ? inOneOf(req.query.role, 'Роль', ALL_ROLES) : null;
    const teamId = req.query.teamId ? int(req.query.teamId, 'Команда', { min: 1 }) : null;
    const status = req.query.status ? inOneOf(req.query.status, 'Статус', ['active', 'blocked']) : null;
    const leadOnly = req.query.leads === '1';

    let sql = `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color,
                      (SELECT t2.id FROM teams t2 WHERE t2.responsible_id = u.id) AS leads_team_id,
                      (SELECT COUNT(*) FROM duties d WHERE d.responsible_id = u.id) AS duty_count
               FROM users u LEFT JOIN teams t ON t.id = u.team_id
               WHERE 1 = 1`;
    const params = [];
    if (role) { sql += ' AND u.role = ?'; params.push(role); }
    if (teamId) { sql += ' AND u.team_id = ?'; params.push(teamId); }
    if (status === 'active') sql += ' AND u.is_active = 1';
    if (status === 'blocked') sql += ' AND u.is_active = 0';
    if (leadOnly) sql += ' AND EXISTS (SELECT 1 FROM teams tl WHERE tl.responsible_id = u.id)';
    if (search) {
      sql += ' AND (LOWER(u.first_name) LIKE ? OR LOWER(u.last_name) LIKE ? OR LOWER(u.middle_name) LIKE ? OR LOWER(u.username) LIKE ?)';
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY u.last_name, u.first_name LIMIT 300';
    const rows = q.all(sql, ...params);
    res.json({
      users: rows.map((r) => ({
        ...publicUser(r),
        roleLabel: ROLE_LABELS[r.role],
        leadsTeamId: r.leads_team_id ?? null,
        dutyCount: r.duty_count ?? 0,
      })),
      total: rows.length,
      canEdit: isStarosta(req.user),
    });
  } catch (err) { next(err); }
});

/* ─────────── GET /api/users/:id — карточка ученика (нельзя подменить id) ── */
router.get('/:id(\\d+)', requirePermission('user.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Пользователь', { min: 1 });
  const u = q.get(
    `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
     FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id,
  );
  if (!u) return next(notFound('Пользователь не найден'));

  // Частный профиль (например, ответственного) скрываем от чужих —
  // карточка видна всем сотрудникам класса, но блок «доступ» только свой.
  const isSelf = req.user.id === id;
  const viewerIsManager = isManager(req.user);
  const leadsTeam = q.get('SELECT * FROM teams WHERE responsible_id = ?', id);
  const team = u.team_id ? q.get('SELECT * FROM teams WHERE id = ?', u.team_id) : null;

  // Дежурства показываем только если есть команда: у сотрудников класса
  // (староста, куратор) team_id пуст, и запрос с undefined роняет SQLite.
  const dutiesTeamId = team?.id ?? leadsTeam?.id ?? null;
  const canSeeDuties = Boolean(viewerIsManager || leadsTeam || u.team_id === req.user.team_id)
    && dutiesTeamId !== null;
  const duties = canSeeDuties
    ? q.all(
      `${DUTY_SELECT} WHERE d.team_id = ? AND d.date <= ? ORDER BY d.date DESC LIMIT 20`,
      dutiesTeamId, todayStr(),
    ).map((d) => dutyPublicLite(d, id))
    : [];

  const marks = q.all('SELECT duty_id, mark FROM duty_marks WHERE user_id = ?', id);
  const stats = {
    total: marks.length,
    served: marks.filter((m) => m.mark === 'served').length,
    absent: marks.filter((m) => m.mark === 'absent').length,
    notServed: marks.filter((m) => m.mark === 'not_served').length,
    unmarked: marks.filter((m) => m.mark === 'unmarked').length,
  };

  res.json({
    user: {
      ...publicUser(u),
      roleLabel: ROLE_LABELS[u.role],
      leadsTeamId: leadsTeam?.id ?? null,
    },
    team: team ? { id: team.id, number: team.number, name: team.name, color: team.color } : null,
    duties,
    stats,
    viewer: { isSelf, isManager: viewerIsManager, isStarosta: isStarosta(req.user) },
  });
});

function dutyPublicLite(d, userId) {
  const m = q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, userId);
  const meta = MARK_META[m?.mark ?? 'unmarked'];
  return {
    id: d.id, date: d.date, dutyTime: d.duty_time, status: d.status,
    teamNumber: d.team_number, teamName: d.team_name, teamColor: d.team_color,
    mark: m?.mark ?? 'unmarked', markLabel: meta.label, markTone: meta.tone,
  };
}

/* ─────────── POST /api/users — создать ученика (староста) ─────────── */
router.post(
  '/',
  requirePermission('user.create'),
  (req, res, next) => uploadAvatar(req, res, (err) => (err ? next(err) : next())),
  (req, res, next) => {
    let avatar = null;
    try {
      const login = vUsername(req.body.username);
      const password = str(req.body.password ?? '', 'Пароль', { required: false, max: 128, trim: false });
      const role = inOneOf(req.body.role ?? ROLES.member, 'Роль', ALL_ROLES);
      const firstName = personName(req.body.firstName, 'Имя');
      const lastName = personName(req.body.lastName, 'Фамилия');
      const middleName = personName(req.body.middleName ?? '', 'Отчество', { required: false });
      const teamId = req.body.teamId ? int(req.body.teamId, 'Команда', { min: 1 }) : null;
      if (role === ROLES.responsible && !teamId) throw bad('Для ответственного нужна команда', 'VALIDATION');
      if (q.get('SELECT id FROM users WHERE username_lc = ?', login)) {
        throw conflict('Такой логин уже занят', 'LOGIN_TAKEN');
      }
      if (req.file) {
        const ext = verifyImage(req.file.path);
        if (!ext) { removeAvatar(req.file.filename); throw bad('Файл не является изображением', 'BAD_FILE'); }
        avatar = req.file.filename;
      }
      const finalPassword = password || login;
      const issues = passwordIssues(finalPassword);
      if (issues.length) throw bad(`Пароль: ${issues.join(', ')}`, 'VALIDATION');

      const ts = new Date().toISOString();
      const userId = transaction(() => {
        const r = q.run(
          `INSERT INTO users (username, username_lc, password_hash, role, first_name, last_name, middle_name,
                              avatar, team_id, is_active, must_change_password, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,1,?,?,?)`,
          login, login, hashPassword(finalPassword), role, firstName, lastName, middleName, avatar, teamId,
          password ? 0 : 1, ts, ts,
        );
        const id = Number(r.lastInsertRowid);
        if (teamId) {
          q.run(`INSERT INTO team_members (team_id, user_id, position, created_at) VALUES (?,?,0,?)
                 ON CONFLICT(team_id, user_id) DO NOTHING`, teamId, id, ts);
        }
        if (role === ROLES.responsible && teamId) {
          q.run('UPDATE teams SET responsible_id = ?, updated_at = ? WHERE id = ? AND responsible_id IS NULL', id, ts, teamId);
        }
        return id;
      });
      audit(req.user.id, 'user.create', 'user', userId, { role, teamId }, clientIp(req));
      const created = q.get(`SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
                             FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, userId);
      return res.status(201).json({ user: { ...publicUser(created), roleLabel: ROLE_LABELS[created.role] } });
    } catch (err) {
      if (avatar) removeAvatar(avatar);
      return next(err);
    }
  },
);

/* ─────────── PATCH /api/users/:id — правка (только староста) ─────────── */
router.patch(
  '/:id(\\d+)',
  requirePermission('user.edit'),
  (req, res, next) => uploadAvatar(req, res, (err) => (err ? next(err) : next())),
  (req, res, next) => {
    const id = int(req.params.id, 'Пользователь', { min: 1 });
    const target = q.get('SELECT * FROM users WHERE id = ?', id);
    if (!target) return next(notFound('Пользователь не найден'));
    let newAvatar = null;
    try {
      const firstName = personName(req.body.firstName ?? target.first_name, 'Имя');
      const lastName = personName(req.body.lastName ?? target.last_name, 'Фамилия');
      const middleName = personName(
        req.body.middleName === undefined ? target.middle_name : req.body.middleName,
        'Отчество', { required: false },
      );
      const role = req.body.role === undefined ? target.role : inOneOf(req.body.role, 'Роль', ALL_ROLES);
      const teamId = req.body.teamId === undefined
        ? target.team_id
        : (req.body.teamId === null ? null : int(req.body.teamId, 'Команда', { min: 1 }));
      const isActive = req.body.isActive === undefined
        ? target.is_active
        : (req.body.isActive ? 1 : 0);

      // --- Инварианты безопасности ---
      if (id === req.user.id) {
        if (role !== target.role) throw forbidden('Нельзя изменить собственную роль', 'SELF_ROLE');
        if (!isActive) throw forbidden('Нельзя заблокировать свой аккаунт', 'SELF_BLOCK');
      }
      if (target.role === ROLES.starosta && role !== ROLES.starosta && isActive) {
        const otherStarosta = q.get(
          "SELECT id FROM users WHERE role = 'starosta' AND is_active = 1 AND id != ?", id,
        );
        if (!otherStarosta) throw bad('В классе должен остаться хотя бы один староста', 'LAST_STAROSTA');
      }
      if (isActive === 0 && id === req.user.id) throw forbidden('Нельзя заблокировать себя', 'SELF_BLOCK');
      if (role === ROLES.responsible && !teamId) throw bad('Для ответственного нужна команда', 'VALIDATION');

      if (req.file) {
        const ext = verifyImage(req.file.path);
        if (!ext) { removeAvatar(req.file.filename); throw bad('Файл не является изображением', 'BAD_FILE'); }
        newAvatar = req.file.filename;
      }
      const avatar = newAvatar ?? target.avatar;
      if (newAvatar && target.avatar) removeAvatar(target.avatar);

      transaction(() => {
        const ts = new Date().toISOString();
        q.run(
          `UPDATE users SET first_name = ?, last_name = ?, middle_name = ?, role = ?, team_id = ?,
                             avatar = ?, is_active = ?, updated_at = ? WHERE id = ?`,
          firstName, lastName, middleName, role, teamId, avatar, isActive, ts, id,
        );
        if (teamId !== target.team_id) {
          q.run('DELETE FROM team_members WHERE user_id = ?', id);
          if (teamId) {
            q.run(`INSERT INTO team_members (team_id, user_id, position, created_at) VALUES (?,?,0,?)
                   ON CONFLICT(team_id, user_id) DO NOTHING`, teamId, id, ts);
          }
        }
        // Если роль перестала быть ответственным — снимаем назначение
        if (role !== ROLES.responsible) q.run('UPDATE teams SET responsible_id = NULL WHERE responsible_id = ?', id);
        if (isActive === 0) destroyAllSessions(id);
      });

      audit(req.user.id, 'user.update', 'user', id, {
        roleChanged: role !== target.role, blocked: isActive === 0, teamChanged: teamId !== target.team_id,
      }, clientIp(req));
      const fresh = q.get(`SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
                           FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id);
      return res.json({ user: { ...publicUser(fresh), roleLabel: ROLE_LABELS[fresh.role] } });
    } catch (err) {
      if (newAvatar) removeAvatar(newAvatar);
      return next(err);
    }
  },
);

/* ─────────── POST /api/users/:id/block — блокировка/разблокировка ─────── */
router.post('/:id(\\d+)/block', requirePermission('user.block'), (req, res, next) => {
  const id = int(req.params.id, 'Пользователь', { min: 1 });
  if (id === req.user.id) return next(forbidden('Нельзя заблокировать свой аккаунт', 'SELF_BLOCK'));
  const target = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) return next(notFound('Пользователь не найден'));
  const block = req.body?.blocked === undefined ? target.is_active === 0 : Boolean(req.body.blocked);
  if (!block && target.role === ROLES.starosta) {
    const others = q.get("SELECT id FROM users WHERE role = 'starosta' AND is_active = 1 AND id != ?", id);
    if (!others) return next(bad('Нельзя заблокировать единственного старосту', 'LAST_STAROSTA'));
  }
  q.run('UPDATE users SET is_active = ?, updated_at = ? WHERE id = ?', block ? 0 : 1, new Date().toISOString(), id);
  if (block) destroyAllSessions(id);
  audit(req.user.id, block ? 'user.block' : 'user.unblock', 'user', id, {}, clientIp(req));
  const fresh = q.get(`SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
                       FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id);
  return res.json({ user: { ...publicUser(fresh), roleLabel: ROLE_LABELS[fresh.role] } });
});

/* ─────────── POST /api/users/:id/password — сброс пароля (староста) ─────── */
router.post(
  '/:id(\\d+)/password',
  requirePermission('user.reset_password'),
  rateLimit({ limit: 30, windowMs: 10 * 60_000 }),
  (req, res, next) => {
    try {
      const id = int(req.params.id, 'Пользователь', { min: 1 });
      const target = q.get('SELECT * FROM users WHERE id = ?', id);
      if (!target) throw notFound('Пользователь не найден');
      const password = str(req.body.newPassword ?? '', 'Новый пароль', { min: 6, max: 128, trim: false });
      const issues = passwordIssues(password);
      if (issues.length) throw bad(`Пароль: ${issues.join(', ')}`, 'VALIDATION');
      q.run(
        'UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?',
        hashPassword(password), new Date().toISOString(), id,
      );
      destroyAllSessions(id);
      audit(req.user.id, 'user.password.reset', 'user', id, {}, clientIp(req));
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  },
);

/* ─────────── GET /api/users/:id/duties — история конкретного ученика ── */
router.get('/:id(\\d+)/duties', requirePermission('user.view.all'), (req, res, next) => {
  const id = int(req.params.id, 'Пользователь', { min: 1 });
  const target = q.get('SELECT * FROM users WHERE id = ?', id);
  if (!target) return next(notFound('Пользователь не найден'));
  const scope = str(req.query.scope ?? 'all', 'Фильтр', { required: false, max: 20 });
  let rows = q.all(
    `${DUTY_SELECT} JOIN duty_marks dm ON dm.duty_id = d.id
     WHERE dm.user_id = ? ORDER BY d.date DESC LIMIT 100`, id,
  );
  if (scope === 'absences') rows = rows.filter((d) => q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, id)?.mark === 'absent');
  if (scope === 'served') rows = rows.filter((d) => q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, id)?.mark === 'served');
  const marks = new Map(q.all('SELECT * FROM duty_marks WHERE user_id = ?', id).map((m) => [m.duty_id, m]));
  res.json({
    duties: rows.map((d) => dutyPublicLite(d, id)),
    total: rows.length,
  });
});

export default router;
