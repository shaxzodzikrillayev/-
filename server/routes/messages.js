/**
 * Сообщения и объявления. Создавать могут только староста и куратор
 * (permission message.send). Адресат: весь класс, конкретная команда
 * или конкретный ответственный. Видимость проверяется canViewMessage().
 */
import express from 'express';
import { q, transaction, audit, getSetting } from '../db.js';
import { requireAuth, requirePermission, clientIp } from '../middleware.js';
import { publicUser, str, int, inOneOf, notFound, forbidden, bad, HttpError, AUDIENCES } from '../util.js';
import { canViewMessage, isManager, ROLES } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

function messagePublic(m, readerId) {
  const read = q.get('SELECT read_at FROM message_reads WHERE message_id = ? AND user_id = ?', m.id, readerId);
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    body: m.body,
    audience: m.audience,
    audienceLabel: audienceLabel(m),
    team: m.team_id ? { id: m.team_id, number: m.team_number, name: m.team_name, color: m.team_color } : null,
    targetUser: m.target_user_id
      ? {
        id: m.target_user_id,
        fullName: `${m.t_last ?? ''} ${m.t_first ?? ''}`.trim(),
        username: m.t_username,
        avatar: `/api/files/avatar/${m.target_user_id}`,
      }
      : null,
    author: m.author_id
      ? {
        id: m.author_id,
        fullName: `${m.a_last ?? ''} ${m.a_first ?? ''}`.trim(),
        role: m.a_role,
        roleLabel: m.a_role === ROLES.starosta ? 'Староста' : m.a_role === ROLES.curator ? 'Куратор' : 'Ответственный',
        avatar: `/api/files/avatar/${m.author_id}`,
      }
      : null,
    isRead: Boolean(read),
    readAt: read?.read_at ?? null,
    createdAt: m.created_at,
  };
}

function audienceLabel(m) {
  if (m.audience === 'class') return 'Весь класс';
  if (m.audience === 'team') return `Команда №${m.team_number ?? '?'}`;
  if (m.audience === 'user') return `Лично: ${(m.t_last ?? '').trim()} ${(m.t_first ?? '').trim()}`.trim();
  return '';
}

const MESSAGE_SELECT = `
  SELECT m.*, t.name AS team_name, t.number AS team_number, t.color AS team_color,
         au.first_name AS a_first, au.last_name AS a_last, au.role AS a_role,
         tu.first_name AS t_first, tu.last_name AS t_last, tu.username AS t_username
  FROM messages m
  LEFT JOIN teams t ON t.id = m.team_id
  LEFT JOIN users au ON au.id = m.author_id
  LEFT JOIN users tu ON tu.id = m.target_user_id
`;

/* ─────────── GET /api/messages — лента, доступная пользователю ─────────── */
router.get('/', requirePermission('message.view'), (req, res) => {
  const scope = str(req.query.scope ?? 'all', 'Фильтр', { required: false, max: 20 });
  let rows = q.all(`${MESSAGE_SELECT} ORDER BY m.created_at DESC LIMIT 200`)
    .filter((m) => canViewMessage(req.user, m));
  if (scope === 'unread') rows = rows.filter((m) => !q.get('SELECT 1 AS x FROM message_reads WHERE message_id = ? AND user_id = ?', m.id, req.user.id));
  if (scope === 'mine') rows = rows.filter((m) => m.author_id === req.user.id);
  if (scope === 'notices') rows = rows.filter((m) => m.kind === 'notice');

  const unread = q.all(`${MESSAGE_SELECT} ORDER BY m.created_at DESC LIMIT 200`)
    .filter((m) => canViewMessage(req.user, m))
    .filter((m) => !q.get('SELECT 1 AS x FROM message_reads WHERE message_id = ? AND user_id = ?', m.id, req.user.id));

  res.json({
    messages: rows.map((m) => messagePublic(m, req.user.id)),
    unreadCount: unread.length,
    canSend: req.user.role === ROLES.starosta || req.user.role === ROLES.curator,
  });
});

/* ─────────── GET /api/messages/unread-count — для бейджа ─────────── */
router.get('/unread-count', requirePermission('message.view'), (req, res) => {
  const rows = q.all('SELECT id, audience, team_id, target_user_id, author_id FROM messages ORDER BY created_at DESC LIMIT 200')
    .filter((m) => canViewMessage(req.user, m));
  const unread = rows.filter((m) => !q.get('SELECT 1 AS x FROM message_reads WHERE message_id = ? AND user_id = ?', m.id, req.user.id));
  res.json({ count: unread.length, latest: unread.slice(0, 5).map((m) => messagePublic(
    q.get(`${MESSAGE_SELECT} WHERE m.id = ?`, m.id), req.user.id,
  )) });
});

/* ─────────── POST /api/messages — создать ─────────── */
router.post('/', requirePermission('message.send'), (req, res, next) => {
  try {
    const kind = inOneOf(req.body.kind ?? 'notice', 'Тип', ['notice', 'message']);
    const title = str(req.body.title, 'Заголовок', { min: 2, max: 120 });
    const body = str(req.body.body, 'Текст', { min: 2, max: 4000 });
    const audience = inOneOf(req.body.audience ?? 'class', 'Адресат', AUDIENCES);

    let teamId = null;
    let targetUserId = null;
    if (audience === 'class' && !isManager(req.user)) {
      throw forbidden('Объявление всему классу может отправить только староста или куратор');
    }
    if (audience === 'team') {
      teamId = int(req.body.teamId, 'Команда', { min: 1 });
      if (!q.get('SELECT id FROM teams WHERE id = ?', teamId)) throw bad('Команда не найдена', 'VALIDATION');
    }
    if (audience === 'user') {
      targetUserId = int(req.body.targetUserId, 'Получатель', { min: 1 });
      const t = q.get('SELECT * FROM users WHERE id = ?', targetUserId);
      if (!t) throw bad('Получатель не найден', 'VALIDATION');
      if (t.is_active === 0) throw bad('Аккаунт получателя заблокирован', 'VALIDATION');
    }
    const ts = new Date().toISOString();
    const id = transaction(() => {
      const r = q.run(
        `INSERT INTO messages (author_id, kind, title, body, audience, team_id, target_user_id, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        req.user.id, kind, title, body, audience, teamId, targetUserId, ts,
      );
      return Number(r.lastInsertRowid);
    });
    audit(req.user.id, 'message.create', 'message', id, { audience, kind }, clientIp(req));
    const m = q.get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
    return res.status(201).json({ message: messagePublic(m, req.user.id) });
  } catch (err) { return next(err); }
});

/* ─────────── POST /api/messages/:id/read ─────────── */
router.post('/:id(\\d+)/read', requirePermission('message.view'), (req, res, next) => {
  const id = int(req.params.id, 'Сообщение', { min: 1 });
  const m = q.get(`${MESSAGE_SELECT} WHERE m.id = ?`, id);
  if (!m) return next(notFound('Сообщение не найдено'));
  if (!canViewMessage(req.user, m)) return next(forbidden('Сообщение вам не адресовано'));
  q.run(
    `INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?,?,?)
     ON CONFLICT(message_id, user_id) DO NOTHING`,
    id, req.user.id, new Date().toISOString(),
  );
  return res.json({ ok: true });
});

/* ─────────── DELETE /api/messages/:id ─────────── */
router.delete('/:id(\\d+)', requirePermission('message.send'), (req, res, next) => {
  const id = int(req.params.id, 'Сообщение', { min: 1 });
  const m = q.get('SELECT * FROM messages WHERE id = ?', id);
  if (!m) return next(notFound('Сообщение не найдено'));
  if (m.author_id !== req.user.id && !isManager(req.user)) {
    return next(forbidden('Можно удалить только своё сообщение'));
  }
  q.run('DELETE FROM messages WHERE id = ?', id);
  audit(req.user.id, 'message.delete', 'message', id, {}, clientIp(req));
  return res.json({ ok: true });
});

export default router;
