/**
 * Системные настройки и журнал действий — только староста.
 * Куратор сюда не попадает: у него нет permission settings.manage / audit.view.
 */
import express from 'express';
import { randomBytes } from 'node:crypto';
import { q, setSetting, audit, getSetting } from '../db.js';
import { requireAuth, requirePermission, clientIp } from '../middleware.js';
import { str, inOneOf, bad, notFound, HttpError, todayStr } from '../util.js';
import { isStarosta, ROLES, ROLE_LABELS } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

/** Гарантирует, что оба кода приглашения существуют (старые базы их не имели). */
function ensureInviteCodes() {
  const codes = {};
  for (const key of ['invite_code_curator', 'invite_code_starosta']) {
    let v = getSetting(key);
    if (!v) { v = randomBytes(4).toString('hex').toUpperCase(); setSetting(key, v); }
    codes[key] = v;
  }
  return codes;
}

const EDITABLE = {
  class_name: { label: 'Название класса', max: 20, def: '5 «Г»' },
  school_name: { label: 'Школа', max: 90, def: '' },
  duty_time_default: { label: 'Время дежурства по умолчанию', max: 40, def: '08:00 – 08:20' },
  registration_open: { label: 'Регистрация', max: 2, def: '1' },
};

/* GET /api/system/settings */
router.get('/settings', requirePermission('settings.manage'), (req, res) => {
  const values = {};
  for (const [k, meta] of Object.entries(EDITABLE)) values[k] = getSetting(k, meta.def);
  res.json({
    values,
    fields: Object.entries(EDITABLE).map(([k, m]) => ({ key: k, label: m.label, max: m.max })),
    canEdit: true,
  });
});

/* PUT /api/system/settings */
router.put('/settings', requirePermission('settings.manage'), (req, res, next) => {
  try {
    const changed = {};
    for (const [k, meta] of Object.entries(EDITABLE)) {
      if (req.body[k] === undefined) continue;
      if (k === 'registration_open') {
        changed[k] = req.body[k] ? '1' : '0';
      } else {
        changed[k] = str(req.body[k], meta.label, { required: false, max: meta.max });
      }
    }
    if (!Object.keys(changed).length) throw bad('Нет изменений', 'VALIDATION');
    for (const [k, v] of Object.entries(changed)) setSetting(k, v);
    audit(req.user.id, 'system.settings.update', 'settings', '', changed, clientIp(req));
    const values = {};
    for (const [k, meta] of Object.entries(EDITABLE)) values[k] = getSetting(k, meta.def);
    res.json({ ok: true, values });
  } catch (err) { next(err); }
});

/* GET /api/system/invite-codes — коды для самостоятельной регистрации
   в роли куратора/старосты. Создаются при первом обращении. */
router.get('/invite-codes', requirePermission('settings.manage'), (req, res) => {
  res.json({ codes: ensureInviteCodes() });
});

/* POST /api/system/invite-codes/regenerate — выдать новые коды */
router.post('/invite-codes/regenerate', requirePermission('settings.manage'), (req, res) => {
  const codes = {
    invite_code_curator: randomBytes(4).toString('hex').toUpperCase(),
    invite_code_starosta: randomBytes(4).toString('hex').toUpperCase(),
  };
  for (const [k, v] of Object.entries(codes)) setSetting(k, v);
  audit(req.user.id, 'system.invite_codes.regenerate', 'settings', '', { ...codes }, clientIp(req));
  res.json({ ok: true, codes });
});

/* GET /api/system/audit — журнал действий */
router.get('/audit', requirePermission('audit.view'), (req, res) => {
  const limit = Math.min(300, Number(req.query.limit) || 120);
  const rows = q.all(
    `SELECT a.*, u.first_name, u.last_name, u.username, u.role FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT ?`, limit,
  );
  res.json({
    entries: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entity: r.entity,
      entityId: r.entity_id,
      meta: safeJson(r.meta),
      ip: r.ip,
      createdAt: r.created_at,
      user: r.user_id ? { id: r.user_id, fullName: `${r.last_name ?? ''} ${r.first_name ?? ''}`.trim(), username: r.username, role: r.role } : null,
    })),
  });
});

function safeJson(v) { try { return JSON.parse(v); } catch { return {}; } }

/* GET /api/system/overview — сводка для панели старосты */
router.get('/overview', requirePermission('stats.view.all'), (req, res) => {
  const today = todayStr();
  const users = q.all(
    `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color,
            (SELECT t2.id FROM teams t2 WHERE t2.responsible_id = u.id) AS leads_team_id
     FROM users u LEFT JOIN teams t ON t.id = u.team_id ORDER BY u.role, u.last_name`,
  );
  res.json({
    users: users.map((u) => ({
      id: u.id, username: u.username, role: u.role, roleLabel: ROLE_LABELS[u.role],
      fullName: `${u.last_name} ${u.first_name}${u.middle_name ? ` ${u.middle_name}` : ''}`,
      firstName: u.first_name, lastName: u.last_name, middleName: u.middle_name,
      avatar: `/api/files/avatar/${u.id}`,
      teamId: u.team_id, teamName: u.team_name, teamNumber: u.team_number, teamColor: u.team_color,
      isActive: u.is_active === 1,
      leadsTeamId: u.leads_team_id ?? null,
      lastLoginAt: u.last_login_at, createdAt: u.created_at,
      mustChangePassword: u.must_change_password === 1,
    })),
    teams: q.all(
      `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id) AS members,
              (SELECT COUNT(*) FROM duties d WHERE d.team_id = t.id) AS duties,
              (SELECT COUNT(*) FROM duties d WHERE d.team_id = t.id AND d.status = 'done') AS done
       FROM teams t ORDER BY t.number`,
    ).map((t) => ({
      id: t.id, number: t.number, name: t.name, color: t.color,
      responsibleId: t.responsible_id, members: t.members, duties: t.duties, done: t.done,
      responsible: t.responsible_id
        ? (() => { const u = users.find((x) => x.id === t.responsible_id); return u ? { id: u.id, fullName: `${u.last_name} ${u.first_name}`, username: u.username, avatar: u.avatar } : null; })()
        : null,
    })),
    stats: {
      students: users.filter((u) => u.role === 'member' || u.role === 'responsible').length,
      responsibles: q.get('SELECT COUNT(*) AS c FROM teams WHERE responsible_id IS NOT NULL').c,
      blocked: users.filter((u) => u.is_active === 0).length,
      todayDuties: q.get('SELECT COUNT(*) AS c FROM duties WHERE date = ?', today).c,
      doneToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status = 'done'", today).c,
      pendingPhotos: q.get("SELECT COUNT(*) AS c FROM photos WHERE check_status = 'pending'").c,
    },
  });
});

export default router;
