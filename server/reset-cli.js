/**
 * `npm run reset` — убирает всех учеников, оставляя рабочие аккаунты класса.
 *
 *   npm run reset            удалить всех учеников (staff остаются)
 *   npm run reset -- --all   полностью пересоздать базу с нуля
 *   npm run reset -- --yes   не спрашивать подтверждение
 *
 * Перед удалением делается резервная копия `dutyhub.db.bak-<дата>`,
 * аватары удаляемых учеников убираются с диска.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { q, transaction, seed, db, DATA_DIR, AVATAR_DIR, dbPath } from './db.js';

const args = new Set(process.argv.slice(2));
const full = args.has('--all');
const assumeYes = args.has('--yes') || args.has('-y');

const pupils = q.all(
  "SELECT id, username, avatar FROM users WHERE role NOT IN ('starosta','curator') ORDER BY id",
);
const staff = q.all("SELECT username FROM users WHERE role IN ('starosta','curator') ORDER BY id");

if (!pupils.length && !full) {
  console.log('[reset] учеников нет — нечего удалять');
  report();
  process.exit(0);
}

console.log(`[reset] база: ${dbPath}`);
if (full) {
  console.log('[reset] РЕЖИМ ПОЛНОГО СБРОСА: база будет пересоздана с нуля.');
} else {
  console.log(`[reset] будет удалено учеников: ${pupils.length}`);
  console.log(`[reset] останутся: ${staff.map((s) => s.username).join(', ') || '—'}`);
}

if (!assumeYes && !process.stdin.isTTY) {
  console.error('[reset] требуется подтверждение: добавьте --yes');
  process.exit(1);
}
if (!assumeYes && !(await confirm('[reset] Продолжить? [y/N] '))) {
  console.log('[reset] отменено');
  process.exit(0);
}

backup();

if (full) {
  wipe();
  if (seed()) console.log('[reset] созданы стартовые данные (starosta, kurator, команды, дежурства)');
  else console.log('[reset] ВНИМАНИЕ: сид не применился');
} else {
  removePupils();
  console.log(`[reset] удалено учеников: ${pupils.length}`);
}

report();
db.close();

/* ───────────────────────── helpers ───────────────────────── */

function backup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${dbPath}.bak-${stamp}`;
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(dbPath, dest);
  console.log(`[reset] резервная копия: ${dest}`);
}

function removePupils() {
  transaction(() => {
    q.run(`DELETE FROM users WHERE role NOT IN ('starosta','curator')`);
    // Команды остаются, но ответственных среди удалённых учеников уже нет.
    q.run('UPDATE teams SET responsible_id = NULL');
    q.run('UPDATE duties SET responsible_id = NULL');
  });
  let files = 0;
  for (const u of pupils) {
    if (!u.avatar) continue;
    try { fs.unlinkSync(path.join(AVATAR_DIR, path.basename(u.avatar))); files++; } catch { /* файла уже нет */ }
  }
  if (files) console.log(`[reset] удалено аватаров: ${files}`);
  // Отметки, сессии и прочтения сообщений сняты каскадом ON DELETE CASCADE.
}

function wipe() {
  transaction(() => {
    for (const table of [
      'message_reads', 'messages', 'sessions', 'audit_log',
      'duty_marks', 'photos', 'duties', 'team_members',
      'users', 'teams', 'settings',
    ]) {
      q.run(`DELETE FROM ${table}`);
    }
    q.run("DELETE FROM sqlite_sequence WHERE name IN ('users','teams','duties','duty_marks','photos','messages')");
  });
  for (const dir of [AVATAR_DIR, path.join(DATA_DIR, 'photos')]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* занят — пропускаем */ }
    }
  }
  console.log('[reset] таблицы и загруженные файлы очищены');
}

function report() {
  const users = q.get('SELECT COUNT(*) AS c FROM users').c;
  const p = q.get("SELECT COUNT(*) AS c FROM users WHERE role NOT IN ('starosta','curator')").c;
  const teams = q.get('SELECT COUNT(*) AS c FROM teams').c;
  const duties = q.get('SELECT COUNT(*) AS c FROM duties').c;
  console.log(`[reset] пользователей: ${users} (учеников: ${p}), команды: ${teams}, дежурства: ${duties}`);
}
