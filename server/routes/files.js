/**
 * Раздача файлов (аватары и фотографии) — ТОЛЬКО после проверки прав.
 * Каталог uploads/ намеренно не подключён как статика.
 *
 * Аватар: загруженная картинка, а если её нет — генерируемый SVG с инициалами
 * и цветом команды. Поэтому у каждого пользователя всегда есть фото профиля.
 */
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { q, AVATAR_DIR, PHOTO_DIR } from '../db.js';
import { requireAuth } from '../middleware.js';
import { int, notFound, forbidden, initialsOf } from '../util.js';
import { canViewPhoto, isManager } from '../permissions.js';

const router = express.Router();

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const PRIVATE_CACHE = 'private, max-age=3600';

const AVATAR_PALETTE = [
  ['#6366f1', '#a5b4fc'], ['#0ea5e9', '#7dd3fc'], ['#10b981', '#6ee7b7'],
  ['#f59e0b', '#fcd34d'], ['#ec4899', '#f9a8d4'], ['#8b5cf6', '#c4b5fd'],
  ['#ef4444', '#fca5a5'], ['#14b8a6', '#5eead4'], ['#f97316', '#fdba74'],
  ['#3b82f6', '#93c5fd'],
];

function avatarSvg(u) {
  const initials = initialsOf(u);
  const teamColor = u.team_color || null;
  const idx = (u.id ?? 0) % AVATAR_PALETTE.length;
  const [bg, fg] = teamColor
    ? [teamColor, '#ffffff']
    : AVATAR_PALETTE[idx];
  const size = initials.length > 2 ? 40 : 52;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100" role="img" aria-label="${escapeXml(initials)}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bg}"/>
      <stop offset="100%" stop-color="${shift(bg)}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="50" fill="url(#g)"/>
  <text x="50" y="50" dy=".35em" text-anchor="middle"
        font-family="'Segoe UI',system-ui,-apple-system,sans-serif" font-size="${size}"
        font-weight="700" fill="${fg}" letter-spacing="1">${escapeXml(initials)}</text>
</svg>`;
}

function shift(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, ((n >> 16) & 255) - 34);
  const g = Math.max(0, ((n >> 8) & 255) - 22);
  const b = Math.min(255, (n & 255) + 26);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

/* GET /api/files/avatar/:id */
router.get('/avatar/:id(\\d+)', requireAuth, (req, res, next) => {
  const id = int(req.params.id, 'Файл', { min: 1 });
  const u = q.get(
    `SELECT u.id, u.avatar, u.first_name, u.last_name, u.username,
            t.color AS team_color
     FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, id,
  );
  if (!u) return next(notFound('Аватар не найден'));

  if (u.avatar) {
    const file = path.join(AVATAR_DIR, path.basename(u.avatar));
    if (IMAGE_EXT.has(path.extname(file).toLowerCase()) && fs.existsSync(file)) {
      res.set('Cache-Control', PRIVATE_CACHE);
      res.type(path.extname(file));
      return res.sendFile(file);
    }
  }
  // Запасной вариант — сгенерированный SVG с инициалами
  res.set('Cache-Control', PRIVATE_CACHE);
  res.type('image/svg+xml');
  return res.send(avatarSvg(u));
});

/* GET /api/files/photo/:id */
router.get('/photo/:id(\\d+)', requireAuth, (req, res, next) => {
  const id = int(req.params.id, 'Фотография', { min: 1 });
  const photo = q.get('SELECT * FROM photos WHERE id = ?', id);
  if (!photo) return next(notFound('Фотография не найдена'));
  if (!canViewPhoto(req.user, photo)) {
    return next(forbidden('Эта фотография вам не доступна'));
  }
  const file = path.join(PHOTO_DIR, path.basename(photo.filename));
  if (!IMAGE_EXT.has(path.extname(file).toLowerCase())) return next(notFound('Фотография не найдена'));
  if (!fs.existsSync(file)) return next(notFound('Фотография не найдена'));
  res.set('Cache-Control', PRIVATE_CACHE);
  res.type(path.extname(file));
  return res.sendFile(file);
});

/* GET /api/files/duty-photo/:id — обложка дежурства */
router.get('/duty-photo/:id(\\d+)', requireAuth, (req, res, next) => {
  const id = int(req.params.id, 'Дежурство', { min: 1 });
  const duty = q.get('SELECT * FROM duties WHERE id = ?', id);
  if (!duty) return next(notFound('Дежурство не найдено'));
  const photo = q.get(
    "SELECT * FROM photos WHERE duty_id = ? AND check_status != 'rejected' ORDER BY created_at LIMIT 1", id,
  );
  if (!photo || !canViewPhoto(req.user, photo)) return next(notFound('Фотография не найдена'));
  const file = path.join(PHOTO_DIR, path.basename(photo.filename));
  if (!fs.existsSync(file)) return next(notFound('Фотография не найдена'));
  res.set('Cache-Control', PRIVATE_CACHE);
  res.type(path.extname(file));
  return res.sendFile(file);
});

export default router;
