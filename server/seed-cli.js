/**
 * `npm run seed` — поднимает схему и создаёт стартовые данные.
 *
 * Идемпотентно: если база уже заполнена, ничего не ломает и просто
 * сообщает текущее состояние. Демо-учеников не создаёт — в сиде
 * остаются только `starosta` и `kurator`, остальных заводит владелец класса.
 */
import { q, seeded, DATA_DIR, db } from './db.js';

const staff = q.all("SELECT username, role FROM users WHERE role IN ('starosta','curator') ORDER BY id");
const pupils = q.get("SELECT COUNT(*) AS c FROM users WHERE role NOT IN ('starosta','curator')").c;
const teams = q.get('SELECT COUNT(*) AS c FROM teams').c;
const duties = q.get('SELECT COUNT(*) AS c FROM duties').c;

console.log(`[seed] база: ${DATA_DIR}`);
console.log(`[seed] сид применён: ${seeded ? 'да' : 'нет (база уже была заполнена)'}`);
console.log(`[seed] пользователей: ${q.get('SELECT COUNT(*) AS c FROM users').c} (учеников: ${pupils})`);
console.log(`[seed] команды: ${teams}, дежурства: ${duties}`);

if (!staff.length) {
  console.log('[seed] ВНИМАНИЕ: нет ни старосты, ни куратора.');
  console.log('[seed] Восстановите базу командой: npm run reset -- --all');
  process.exitCode = 1;
} else {
  for (const s of staff) console.log(`[seed]   ${s.username} — ${s.role}`);
}

db.close();
