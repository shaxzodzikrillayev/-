/**
 * DUTY HUB — слой базы данных (SQLite через встроенный node:sqlite).
 * Схема, миграции и централизованное хранилище всех данных системы.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.DUTYHUB_DATA
  ? path.resolve(process.env.DUTYHUB_DATA)
  : path.join(ROOT, 'data');
export const UPLOAD_DIR = process.env.DUTYHUB_UPLOADS
  ? path.resolve(process.env.DUTYHUB_UPLOADS)
  : path.join(ROOT, 'uploads');
export const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
export const PHOTO_DIR = path.join(UPLOAD_DIR, 'photos');

for (const dir of [DATA_DIR, UPLOAD_DIR, AVATAR_DIR, PHOTO_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const dbPath = path.join(DATA_DIR, 'dutyhub.db');
export const db = new DatabaseSync(dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  username_lc   TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('starosta','curator','responsible','member')),
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  middle_name   TEXT    NOT NULL DEFAULT '',
  avatar        TEXT,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         INTEGER NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  color          TEXT    NOT NULL DEFAULT '#6366f1',
  responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS team_members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL,
  UNIQUE (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS duties (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL UNIQUE,
  team_id        INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  duty_time      TEXT    NOT NULL DEFAULT '08:00 – 08:20',
  status         TEXT    NOT NULL CHECK (status IN ('planned','pending','done','missed')),
  comment        TEXT    NOT NULL DEFAULT '',
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL,
  updated_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS duty_marks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_id    INTEGER NOT NULL REFERENCES duties(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mark       TEXT    NOT NULL CHECK (mark IN ('present','absent','unmarked','served','not_served')),
  note       TEXT    NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT    NOT NULL,
  UNIQUE (duty_id, user_id)
);

CREATE TABLE IF NOT EXISTS photos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  duty_id       INTEGER REFERENCES duties(id) ON DELETE SET NULL,
  filename      TEXT    NOT NULL,
  original_name TEXT    NOT NULL,
  mime          TEXT    NOT NULL,
  size          INTEGER NOT NULL,
  uploaded_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  team_id       INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  date          TEXT    NOT NULL,
  check_status  TEXT    NOT NULL DEFAULT 'pending' CHECK (check_status IN ('pending','approved','rejected')),
  review_note   TEXT    NOT NULL DEFAULT '',
  checked_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  checked_at    TEXT,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  author_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind          TEXT    NOT NULL DEFAULT 'notice' CHECK (kind IN ('notice','message')),
  title         TEXT    NOT NULL,
  body          TEXT    NOT NULL,
  audience      TEXT    NOT NULL CHECK (audience IN ('class','team','user')),
  team_id       INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at    TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at    TEXT    NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT   NOT NULL,
  created_at TEXT    NOT NULL,
  last_seen  TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  ip         TEXT    NOT NULL DEFAULT '',
  user_agent TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT    NOT NULL,
  entity     TEXT    NOT NULL DEFAULT '',
  entity_id  TEXT    NOT NULL DEFAULT '',
  meta       TEXT    NOT NULL DEFAULT '',
  ip         TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_team       ON users(team_id);
CREATE INDEX IF NOT EXISTS idx_members_team     ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_members_user     ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_duties_date      ON duties(date);
CREATE INDEX IF NOT EXISTS idx_duties_team      ON duties(team_id);
CREATE INDEX IF NOT EXISTS idx_marks_duty       ON duty_marks(duty_id);
CREATE INDEX IF NOT EXISTS idx_marks_user       ON duty_marks(user_id);
CREATE INDEX IF NOT EXISTS idx_photos_duty      ON photos(duty_id);
CREATE INDEX IF NOT EXISTS idx_photos_date      ON photos(date);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_reads_user       ON message_reads(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_created    ON audit_log(created_at);
`);

/* ───────────────────────── helpers ───────────────────────── */

const nowIso = () => new Date().toISOString();

export const q = {
  all: (sql, ...p) => db.prepare(sql).all(...p),
  get: (sql, ...p) => db.prepare(sql).get(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

/* ───────────────────────── миграции ───────────────────────── */

/**
 * `CREATE TABLE IF NOT EXISTS` не добавляет новые колонки в уже созданную базу,
 * поэтому недостающие колонки докубавляются отдельными ALTER TABLE.
 * Так обновление не требует удалять data/dutyhub.db вручную.
 */
function columnsOf(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
}

const MIGRATIONS = [
  ['sessions', 'csrf_secret', "TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'ip', "TEXT NOT NULL DEFAULT ''"],
  ['sessions', 'user_agent', "TEXT NOT NULL DEFAULT ''"],
  ['users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'last_login_at', 'TEXT'],
  ['settings', 'updated_at', "TEXT NOT NULL DEFAULT ''"],
  ['photos', 'review_note', "TEXT NOT NULL DEFAULT ''"],
  ['duty_marks', 'note', "TEXT NOT NULL DEFAULT ''"],
];

export function migrate(log = true) {
  const applied = [];
  for (const [table, column, definition] of MIGRATIONS) {
    if (columnsOf(table).has(column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    applied.push(`${table}.${column}`);
  }
  if (applied.length && log) console.log(`[db] миграции применены: ${applied.join(', ')}`);
  return applied;
}

export function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }
}

export function audit(userId, action, entity = '', entityId = '', meta = {}, ip = '') {
  q.run(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, meta, ip, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    userId ?? null, action, entity, String(entityId ?? ''),
    JSON.stringify(meta ?? {}), ip ?? '', nowIso(),
  );
}

export function getSetting(key, fallback = null) {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  q.run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key, String(value), nowIso(),
  );
}

/** Серверный секрет для подписи cookie сессий. Генерируется один раз. */
let _serverSecret = null;
export function serverSecret() {
  if (_serverSecret) return _serverSecret;
  const fromEnv = process.env.DUTYHUB_SECRET;
  if (fromEnv && fromEnv.length >= 32) {
    _serverSecret = fromEnv;
    return _serverSecret;
  }
  const row = q.get("SELECT value FROM settings WHERE key = 'server_secret'");
  if (row?.value) {
    _serverSecret = row.value;
  } else {
    _serverSecret = randomBytes(32).toString('base64url');
    q.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('server_secret', ?, ?)
       ON CONFLICT(key) DO NOTHING`,
      _serverSecret, nowIso(),
    );
  }
  return _serverSecret;
}

/* ───────────────────────── сид-данные ───────────────────────── */

/**
 * Демо-сид содержит только staff-аккаунты. Учеников и ответственных
 * владелец класса заводит сам через раздел «Ученики» / «Команды»,
 * поэтому список намеренно пустой.
 */
const ROSTER = [
  ['starosta', 'starosta', 'Ковалёв', 'Артём', 'Дмитриевич', 'starosta'],
  ['kurator', 'kurator', 'Степанова', 'Марина', 'Игоревна', 'kurator'],
];

const TEAMS = [
  { number: 1, name: 'Команда №1 — Звёзды',   color: '#6366f1' },
  { number: 2, name: 'Команда №2 — Комета',   color: '#0ea5e9' },
  { number: 3, name: 'Команда №3 — Орбита',  color: '#10b981' },
  { number: 4, name: 'Команда №4 — Планета',  color: '#f59e0b' },
  { number: 5, name: 'Команда №5 — Метеор',   color: '#ec4899' },
];

const HOURS = [
  ['09:00', 'Беседка'],
  ['10:00', 'Главный зал'],
  ['11:00', 'Коридор 2 этаж'],
  ['12:00', 'Кабинет 5-12'],
  ['13:00', 'Обеденный зал'],
  ['14:00', 'Спортзал'],
  ['15:00', 'Библиотека'],
  ['16:00', 'Раздевалка / гардероб'],
];

const COMMENT = 'Дежурство сдано, кабинет чистый.';

export function seed() {
  const count = q.get('SELECT COUNT(*) AS c FROM users').c;
  if (count > 0) return false;

  transaction(() => {
    const ts = nowIso();
    for (const t of TEAMS) {
      q.run(
        `INSERT INTO teams (number, name, color, responsible_id, created_at, updated_at)
         VALUES (?,?,?,NULL,?,?)`,
        t.number, t.name, t.color, ts, ts,
      );
    }
    const teamByNumber = new Map(TEAMS.map((t) => [t.number, q.get('SELECT id FROM teams WHERE number = ?', t.number).id]));

    for (const [username, login, last, first, middle, teamKey] of ROSTER) {
      const isStarosta = username === 'starosta';
      const isCurator = username === 'kurator';
      const role = isStarosta ? 'starosta' : isCurator ? 'curator' : username.startsWith('otvet') ? 'responsible' : 'member';
      const teamId = isStarosta || isCurator ? null : teamByNumber.get(Number(teamKey.replace('team', '')));
      q.run(
        `INSERT INTO users (username, username_lc, password_hash, role, first_name, last_name, middle_name,
                            avatar, team_id, is_active, must_change_password, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,NULL,?,1,0,?,?)`,
        username, username.toLowerCase(), hashPassword(username), role, first, last, middle,
        teamId, ts, ts,
      );
      const userId = q.get('SELECT id FROM users WHERE username_lc = ?', username.toLowerCase()).id;
      if (teamId) {
        q.run(
          `INSERT INTO team_members (team_id, user_id, position, created_at) VALUES (?,?,0,?)`,
          teamId, userId, ts,
        );
      }
    }

    // Ответственных назначает владелец класса через интерфейс,
    // поэтому в чистом сиде команды остаются пустыми.

    // История дежурств: 3 прошлые недели + текущая неделя
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let back = 24; back >= 0; back--) {
      const d = new Date(today);
      d.setDate(d.getDate() - back);
      const dateStr = toDateStr(d);
      if (d.getDay() === 0 || d.getDay() === 6) continue;
      const teamId = teamByNumber.get((d.getDay() - 1) % 5 + 1);
      const team = q.get('SELECT * FROM teams WHERE id = ?', teamId);
      const [time, zone] = HOURS[(d.getDay() - 1 + back) % HOURS.length];
      const dutyTime = `${time} · ${zone}`;
      const status = back > 2 ? (back % 7 === 0 ? 'missed' : 'done') : back > 0 ? 'done' : 'planned';
      q.run(
        `INSERT INTO duties (date, team_id, responsible_id, duty_time, status, comment, created_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        dateStr, teamId, team.responsible_id, dutyTime, status, status === 'done' ? COMMENT : '',
        q.get("SELECT id FROM users WHERE username_lc = 'starosta'").id, ts, ts,
      );
      const dutyId = q.get('SELECT id FROM duties WHERE date = ?', dateStr).id;

      const members = q.all(
        'SELECT u.id FROM users u JOIN team_members m ON m.user_id = u.id WHERE m.team_id = ?', teamId,
      );
      members.forEach((m, i) => {
        const r = (i + back) % 11;
        const mark = status === 'planned' ? 'unmarked'
          : status === 'missed' ? (r % 5 === 0 ? 'absent' : 'served')
            : r < 2 ? 'absent' : r < 4 ? 'not_served' : 'served';
        q.run(
          `INSERT INTO duty_marks (duty_id, user_id, mark, note, updated_by, updated_at)
           VALUES (?,?,?,'',?,?)`,
          dutyId, m.id, mark, team.responsible_id, ts,
        );
      });
    }

    setSetting('class_name', '5 «Г»');
    setSetting('class_letter', 'Г');
    setSetting('school_name', 'Средняя общеобразовательная школа №17');
    setSetting('duty_cycle', '1');
    setSetting('registration_open', '1');
    setSetting('seeded_at', ts);
  });
  return true;
}

export function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export const seeded = (migrate(false), seed());
