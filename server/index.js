/**
 * DUTY HUB — точка входа сервера.
 * Порядок важен: helmet → cookie-parser → статика (только public/) →
 * сессия → CSRF → API → SPA-fallback.
 */
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ROOT, seeded, getSetting, dbPath, q } from './db.js';
import { attachUser, csrfGuard, cleanupSessions } from './middleware.js';
import { can } from './permissions.js';
import { HttpError } from './util.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import teamRoutes from './routes/teams.js';
import dutyRoutes from './routes/duties.js';
import photoRoutes from './routes/photos.js';
import messageRoutes from './routes/messages.js';
import statsRoutes from './routes/stats.js';
import systemRoutes from './routes/system.js';
import fileRoutes from './routes/files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'same-origin' },
  hsts: process.env.NODE_ENV === 'production' ? undefined : false,
}));

app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

// Статика только из public/ (каталог uploads намеренно не раздаётся)
app.use(express.static(PUBLIC_DIR, {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  index: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));

// Контекст пользователя + CSRF
app.use(attachUser);
app.use('/api', csrfGuard);
app.use('/api', (req, _res, next) => { req.perms = { can }; next(); });

app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/teams', teamRoutes);
app.use('/api/duties', dutyRoutes);
app.use('/api/photos', photoRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/files', fileRoutes);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'duty-hub', class: getSetting('class_name', '5 «Г»'), time: new Date().toISOString() });
});

// 404 для API
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Метод API не найден', code: 'NOT_FOUND' });
});

// Каталоги приложения никогда не отдаются клиенту и не подменяются SPA.
const PRIVATE_PREFIX = /^\/(?:data|uploads|server|tests|node_modules)(?:\/|$)/i;

// SPA fallback. Приложение использует hash-роутинг, поэтому настоящие
// маршруты не имеют расширения: всё, что похоже на файл, — это 404,
// а не «страница приложения».
app.get('*', (req, res, next) => {
  if (PRIVATE_PREFIX.test(req.path)) return next();
  if (path.extname(req.path)) return next();
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (!fs.existsSync(index)) return res.status(500).send('index.html отсутствует');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(index);
});

// 404 для всего, что не совпало со статикой и SPA
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Метод API не найден', code: 'NOT_FOUND' });
  }
  res.status(404).type('text/plain').send('404 — страница не найдена');
});

// Единый обработчик ошибок
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  const code = err.code || (status === 500 ? 'INTERNAL' : 'ERROR');
  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  if (res.headersSent) return;
  const message = status >= 500
    ? 'Внутренняя ошибка сервера. Попробуйте позже.'
    : (err.message || 'Ошибка запроса');
  res.status(status).json({ error: message, code });
});

const server = app.listen(PORT, HOST, () => {
  const pupils = q.get("SELECT COUNT(*) AS c FROM users WHERE role NOT IN ('starosta','curator')").c;
  const lines = [
    '',
    '  🧹  DUTY HUB — система управления дежурствами класса',
    `      Класс: ${getSetting('class_name', '5 «Г»')}`,
    `      Адрес: http://localhost:${PORT}`,
    `      Данные: ${dbPath}`,
    seeded ? '      ✓ База данных создана и заполнена' : '      ✓ Существующая база данных подключена',
    `      Учеников в базе: ${pupils}`,
    '',
    '      Стартовые доступы (логин = пароль):',
    '        👑 starosta / starosta   — панель старосты',
    '        👨‍🏫 kurator  / kurator    — панель куратора',
  ];
  if (!pupils) {
    lines.push('', '      Учеников пока нет — добавьте их в разделе «Ученики» или', '      откройте регистрацию, чтобы класс записался сам.');
  }
  lines.push('');
  console.log(lines.join('\n'));
});

const interval = setInterval(cleanupSessions, 1000 * 60 * 15);
interval.unref();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n  Завершение работы…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app, server };
