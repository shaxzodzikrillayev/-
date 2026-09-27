/**
 * Регистрация / вход / выход / профиль.
 * Публичная регистрация создаёт ученика без команды — состав формирует
 * староста в разделе «Ученики». Роли «куратор» и «староста» требуют
 * кода приглашения, который хранится в настройках и выдаётся старостой.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, transaction, audit, getSetting } from '../db.js';
import { hashPassword, verifyPassword, passwordIssues } from '../auth-utils.js';
import { createSession, destroySession, destroyAllSessions, requireAuth, rateLimit, clientIp } from '../middleware.js';
import { uploadAvatar, verifyImage, removeAvatar } from '../uploads.js';
import {
  publicUser, str, username as vUsername, personName, bad, conflict, HttpError,
} from '../util.js';
import { permissionsForClient, ROLES, ROLE_LABELS } from '../permissions.js';

const router = express.Router();

/** Роли, доступные при регистрации, и код, который открывает каждую из них. */
const CODE_ROLES = {
  [ROLES.curator]: 'invite_code_curator',
  [ROLES.starosta]: 'invite_code_starosta',
};
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

/** Сравнение кодов без утечки времени. */
function codeMatches(given, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function sessionPayload(user, csrfToken = null) {
  const teams = q.all('SELECT id, number, name, color, responsible_id FROM teams ORDER BY number');
  return {
    authenticated: true,
    user: publicUser(user),
    permissions: permissionsForClient(user),
    roleLabel: ROLE_LABELS[user.role],
    csrfToken,
    teams: teams.map((t) => ({
      id: t.id, number: t.number, name: t.name, color: t.color, responsibleId: t.responsible_id,
    })),
    classInfo: {
      name: getSetting('class_name', '5 «Г»'),
      school: getSetting('school_name', ''),
      registrationOpen: getSetting('registration_open', '1') === '1',
    },
  };
}

function userById(id) {
  return q.get(
    `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
     FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id,
  );
}

/* ───────────────────── GET /api/auth/bootstrap ───────────────────── */
router.get('/bootstrap', (req, res) => {
  res.json({
    authenticated: Boolean(req.user),
    classInfo: {
      name: getSetting('class_name', '5 «Г»'),
      school: getSetting('school_name', ''),
      registrationOpen: getSetting('registration_open', '1') === '1',
    },
    roleLabels: ROLE_LABELS,
    canRegister: getSetting('registration_open', '1') === '1',
  });
});

/* ───────────────────── GET /api/auth/teams (публичный список для регистрации) ─ */
router.get('/teams', (req, res) => {
  if (getSetting('registration_open', '1') !== '1') {
    return res.json({ teams: [] });
  }
  const rows = q.all('SELECT id, number, name, color FROM teams ORDER BY number');
  res.json({ teams: rows.map((t) => ({ id: t.id, number: t.number, name: t.name, color: t.color })) });
});

/* ───────────────────── GET /api/auth/me ───────────────────── */
router.get('/me', (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json(sessionPayload(req.user, req.csrfToken));
});

/* ───────────────────── POST /api/auth/register ───────────────────── */
router.post(
  '/register',
  rateLimit({ limit: 40, windowMs: 10 * 60_000, message: 'Слишком много регистраций. Попробуйте позже.' }),
  (req, res, next) => uploadAvatar(req, res, (err) => (err ? next(err) : next())),
  (req, res, next) => {
    let savedAvatar = null;
    try {
      if (getSetting('registration_open', '1') !== '1') {
        throw new HttpError(403, 'Регистрация в системе закрыта', 'REGISTRATION_CLOSED');
      }

      // Ученик регистрируется без команды и без кода: состав формирует староста.
      // Куратор и староста — только по коду приглашения из настроек.
      const requestedRole = str(req.body.role ?? ROLES.member, 'Роль', { max: 20 });
      let role = ROLES.member;
      if (requestedRole !== ROLES.member) {
        const settingKey = CODE_ROLES[requestedRole];
        if (!settingKey) throw new HttpError(403, 'Такую роль выбрать нельзя', 'ROLE_NOT_ALLOWED');
        const code = str(req.body.code ?? '', 'Код', { required: false, max: 64, trim: false });
        if (!codeMatches(code, getSetting(settingKey))) {
          throw new HttpError(403, 'Неверный код приглашения', 'BAD_INVITE_CODE');
        }
        role = requestedRole;
      }

      const login = vUsername(req.body.username);
      const password = str(req.body.password, 'Пароль', { min: 6, max: 128, trim: false });
      const issues = passwordIssues(password);
      if (issues.length) throw bad(`Пароль: ${issues.join(', ')}`, 'VALIDATION');

      const firstName = personName(req.body.firstName, 'Имя');
      const lastName = personName(req.body.lastName, 'Фамилия');
      const middleName = personName(req.body.middleName, 'Отчество', { required: false });

      if (q.get('SELECT id FROM users WHERE username_lc = ?', login)) {
        throw conflict('Такой логин уже занят', 'LOGIN_TAKEN');
      }

      const file = req.file;
      if (!file) throw bad('Прикрепите фото профиля', 'VALIDATION');
      const realExt = verifyImage(file.path);
      if (!realExt) {
        removeAvatar(file.filename);
        throw bad('Файл не является корректным изображением', 'BAD_FILE');
      }
      if (realExt !== EXT_BY_MIME[file.mimetype]) {
        const renamed = `${path.basename(file.filename, EXT_BY_MIME[file.mimetype])}${realExt}`;
        fs.renameSync(file.path, path.join(path.dirname(file.path), renamed));
        file.filename = renamed;
      }
      savedAvatar = file.filename;

      const userId = transaction(() => {
        const ts = new Date().toISOString();
        // team_id остаётся NULL: ученик приходит без команды, ответственного
        // и состав команды назначает староста в разделе «Ученики».
        const r = q.run(
          `INSERT INTO users (username, username_lc, password_hash, role, first_name, last_name, middle_name,
                              avatar, team_id, is_active, must_change_password, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,NULL,1,0,?,?)`,
          login, login, hashPassword(password), role, firstName, lastName, middleName,
          file.filename, ts, ts,
        );
        const id = Number(r.lastInsertRowid);
        audit(id, 'auth.register', 'user', id, { role }, clientIp(req));
        return id;
      });

      const user = userById(userId);
      const session = createSession(res, req, user.id);
      res.status(201).json(sessionPayload(user, session.csrfToken));
    } catch (err) {
      if (savedAvatar) removeAvatar(savedAvatar);
      next(err);
    }
  },
);

/* ───────────────────── POST /api/auth/login ───────────────────── */
router.post(
  '/login',
  rateLimit({ limit: 25, windowMs: 5 * 60_000, message: 'Слишком много попыток входа.' }),
  (req, res, next) => {
    try {
      const login = str(req.body.username, 'Логин', { max: 24 }).toLowerCase();
      const password = str(req.body.password, 'Пароль', { max: 128, trim: false });
      const user = q.get(
        `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
         FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.username_lc = ?`, login,
      );
      const fail = () => {
        audit(user?.id ?? null, 'auth.login.fail', 'user', login, {}, clientIp(req));
        throw new HttpError(401, 'Неверный логин или пароль', 'BAD_CREDENTIALS');
      };
      if (!user) { fail(); return; }
      if (!verifyPassword(password, user.password_hash)) fail();
      if (user.is_active === 0) {
        throw new HttpError(403, 'Аккаунт заблокирован. Обратитесь к старосте класса.', 'ACCOUNT_BLOCKED');
      }
      const session = createSession(res, req, user.id);
      q.run('UPDATE users SET last_login_at = ? WHERE id = ?', new Date().toISOString(), user.id);
      audit(user.id, 'auth.login', 'user', user.id, { role: user.role }, clientIp(req));
      res.json(sessionPayload(user, session.csrfToken));
    } catch (err) { next(err); }
  },
);

/* ───────────────────── POST /api/auth/logout ───────────────────── */
router.post('/logout', (req, res) => {
  if (req.user) audit(req.user.id, 'auth.logout', 'user', req.user.id, {}, clientIp(req));
  destroySession(req, res);
  res.json({ ok: true });
});

/* ───────────────────── PATCH /api/auth/profile (свои данные) ───────────── */
router.patch(
  '/profile',
  requireAuth,
  (req, res, next) => uploadAvatar(req, res, (err) => (err ? next(err) : next())),
  (req, res, next) => {
    const me = req.user;
    let savedAvatar = null;
    try {
      const firstName = personName(req.body.firstName ?? me.first_name, 'Имя');
      const lastName = personName(req.body.lastName ?? me.last_name, 'Фамилия');
      const middleName = personName(
        req.body.middleName === undefined ? me.middle_name : req.body.middleName,
        'Отчество', { required: false },
      );
      let avatar = me.avatar;
      if (req.file) {
        const realExt = verifyImage(req.file.path);
        if (!realExt) {
          removeAvatar(req.file.filename);
          throw bad('Файл не является корректным изображением', 'BAD_FILE');
        }
        savedAvatar = req.file.filename;
        const old = me.avatar;
        avatar = req.file.filename;
        if (old) removeAvatar(old);
      }
      // Роль, логин, команда и активность здесь намеренно НЕ меняются
      q.run(
        `UPDATE users SET first_name = ?, last_name = ?, middle_name = ?, avatar = ?, updated_at = ?
         WHERE id = ?`,
        firstName, lastName, middleName, avatar, new Date().toISOString(), me.id,
      );
      audit(me.id, 'user.profile.update', 'user', me.id, { avatarChanged: Boolean(req.file) }, clientIp(req));
      res.json(sessionPayload(userById(me.id), req.csrfToken));
    } catch (err) {
      if (savedAvatar) removeAvatar(savedAvatar);
      next(err);
    }
  },
);

/* ───────────────────── POST /api/auth/password (смена своего пароля) ──── */
router.post('/password', requireAuth, (req, res, next) => {
  try {
    const current = str(req.body.currentPassword, 'Текущий пароль', { max: 128, trim: false });
    const next_ = str(req.body.newPassword, 'Новый пароль', { min: 6, max: 128, trim: false });
    const issues = passwordIssues(next_);
    if (issues.length) throw bad(`Новый пароль: ${issues.join(', ')}`, 'VALIDATION');
    if (!verifyPassword(current, req.user.password_hash)) {
      throw new HttpError(400, 'Текущий пароль указан неверно', 'BAD_CREDENTIALS');
    }
    if (current === next_) throw bad('Новый пароль должен отличаться от текущего', 'VALIDATION');
    q.run(
      'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?',
      hashPassword(next_), new Date().toISOString(), req.user.id,
    );
    // Все остальные сессии этого пользователя закрываем
    destroyAllSessions(req.user.id);
    const session = createSession(res, req, req.user.id);
    audit(req.user.id, 'user.password.change', 'user', req.user.id, {}, clientIp(req));
    res.json({ ok: true, ...sessionPayload(userById(req.user.id), session.csrfToken) });
  } catch (err) { next(err); }
});

/* ───────────────────── GET /api/auth/users-search (для выбора в сообщениях) ─ */
router.get('/directory', requireAuth, (req, res) => {
  const term = str(req.query.q ?? '', 'Поиск', { required: false, max: 60 }).toLowerCase();
  const rows = q.all(
    `SELECT * FROM users WHERE is_active = 1 ORDER BY last_name, first_name`,
  ).filter((u) => {
    if (!term) return true;
    return [u.username, u.first_name, u.last_name, u.middle_name]
      .join(' ').toLowerCase().includes(term);
  });
  res.json({ users: rows.slice(0, 40).map(publicUser) });
});

export default router;
