/**
 * Сессии, аутентификация и защита запросов.
 * Сессия хранится в БД, cookie — httpOnly + подписанная HMAC.
 * CSRF-токен выводится из секрета сессии, поэтому клиент его подделать не может.
 */
import crypto from 'node:crypto';
import { q, audit, serverSecret } from './db.js';
import { signValue, unsignValue, safeEqual } from './auth-utils.js';

export const SESSION_COOKIE = 'dh_session';
export const CSRF_HEADER = 'x-csrf-token';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 дней
const TOUCH_EVERY_MS = 60 * 1000;

export function cookieOptions(req, maxAgeSec) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(req),
    path: '/',
    maxAge: maxAgeSec,
  };
}

export function isSecure(req) {
  return req.secure || req.get('x-forwarded-proto') === 'https';
}

export function createSession(res, req, userId) {
  const id = crypto.randomBytes(32).toString('base64url');
  const secret = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  q.run(
    `INSERT INTO sessions (id, user_id, csrf_secret, created_at, last_seen, expires_at, ip, user_agent)
     VALUES (?,?,?,?,?,?,?,?)`,
    id, userId, secret, now.toISOString(), now.toISOString(), expires.toISOString(),
    clientIp(req), String(req.get('user-agent') ?? '').slice(0, 200),
  );
  // Cookie = "<id>.<HMAC(server_secret, id)>" — подделывать без секрета нельзя
  res.cookie(SESSION_COOKIE, signValue(id, serverSecret()), cookieOptions(req, Math.floor(SESSION_TTL_MS / 1000)));
  return {
    id,
    secret,
    expiresAt: expires,
    csrfToken: crypto.createHmac('sha256', secret).update(`csrf:${id}`).digest('base64url'),
  };
}

export function destroySession(req, res) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (raw) {
    const id = unsignValue(raw, serverSecret());
    if (id) q.run('DELETE FROM sessions WHERE id = ?', id);
  }
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(req, 0) });
}

export function destroyAllSessions(userId) {
  q.run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function clientIp(req) {
  return String(req.ip ?? req.socket?.remoteAddress ?? '').slice(0, 60);
}

function loadSession(req) {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw || typeof raw !== 'string') return null;
  // Проверяем подпись серверным секретом: подделанная cookie отбрасывается
  const id = unsignValue(raw, serverSecret());
  if (!id) return null;
  const session = q.get('SELECT * FROM sessions WHERE id = ?', id);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    q.run('DELETE FROM sessions WHERE id = ?', id);
    return null;
  }
  return { ...session, secret: session.csrf_secret };
}

function loadUser(session) {
  if (!session) return null;
  const user = q.get(
    `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
     FROM users u LEFT JOIN teams t ON t.id = u.team_id
     WHERE u.id = ?`, session.user_id,
  );
  if (!user) return null;
  return user;
}

const touchTimers = new Map();
function touch(session) {
  const last = touchTimers.get(session.id) ?? 0;
  if (Date.now() - last < TOUCH_EVERY_MS) return;
  touchTimers.set(session.id, Date.now());
  q.run('UPDATE sessions SET last_seen = ? WHERE id = ?', new Date().toISOString(), session.id);
}

/** Кладёт req.session / req.user, если есть. Ничего не блокирует. */
export function attachUser(req, res, next) {
  const session = loadSession(req);
  req.session = session;
  req.user = loadUser(session);
  if (session && req.user) {
    touch(session);
    req.csrfToken = crypto.createHmac('sha256', session.secret).update(`csrf:${session.id}`).digest('base64url');
  }
  if (req.user && req.user.is_active === 0) {
    // Заблокированный пользователь не проходит дальше даже с валидной сессией
    destroySession(req, res);
    req.session = null;
    req.user = null;
  }
  next();
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function csrfGuard(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  if (!req.user) return next(); // неавторизованные запросы обработает requireAuth
  if (req.get('x-requested-with') !== 'dutyhub') {
    return res.status(403).json({ error: 'Запрос отклонён: неверный клиент.', code: 'BAD_CLIENT' });
  }
  const sent = req.get(CSRF_HEADER) ?? '';
  if (!sent || !req.csrfToken || !safeEqual(sent, req.csrfToken)) {
    return res.status(403).json({ error: 'Защитный токен недействителен. Обновите страницу.', code: 'BAD_CSRF' });
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const o = new URL(origin);
      const host = req.get('host');
      if (o.host !== host) {
        return res.status(403).json({ error: 'Запрос с чужого домена отклонён.', code: 'BAD_ORIGIN' });
      }
    } catch {
      return res.status(403).json({ error: 'Некорректный Origin.', code: 'BAD_ORIGIN' });
    }
  }
  return next();
}

export function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Требуется вход в аккаунт', code: 'UNAUTHENTICATED' });
  }
  return next();
}

export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Требуется вход в аккаунт', code: 'UNAUTHENTICATED' });
    }
    const { can } = req.perms;
    const ok = permissions.some((p) => can(req.user, p));
    if (!ok) {
      audit(req.user.id, 'permission.denied', 'route', req.originalUrl, { need: permissions }, clientIp(req));
      return res.status(403).json({ error: 'Недостаточно прав для этого действия', code: 'FORBIDDEN' });
    }
    return next();
  };
}

export function cleanupSessions() {
  q.run('DELETE FROM sessions WHERE expires_at < ?', new Date().toISOString());
  const cutoff = new Date(Date.now() - TOUCH_EVERY_MS * 5).getTime();
  for (const [id, ts] of touchTimers) {
    if (ts < cutoff) touchTimers.delete(id);
  }
}

/* ───────── простой rate limiter (в памяти) ───────── */
const buckets = new Map();

export function rateLimit({ key = (req) => clientIp(req), limit = 20, windowMs = 60_000, message = 'Слишком много попыток. Подождите немного.' } = {}) {
  return (req, res, next) => {
    const k = `${req.method}:${req.baseUrl}${req.path}:${key(req)}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(k, b);
    }
    b.count += 1;
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - b.count)));
    if (b.count > limit) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: `${message} (${retry} с)`, code: 'RATE_LIMITED' });
    }
    if (buckets.size > 5000) {
      for (const [kk, vv] of buckets) if (now > vv.reset) buckets.delete(kk);
    }
    return next();
  };
}
