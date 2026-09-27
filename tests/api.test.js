/**
 * Интеграционный аудит API: регистрация, вход/выход, роли, права, команды,
 * календарь, дежурства, отметки, загрузка фото, сообщения, защита страниц.
 * Запуск:  node tests/api.test.js   (сервер поднимается автоматически)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 4100 + Math.floor(Math.random() * 700);
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'dutyhub-test-'));
const DB_PATH = path.join(TMP_ROOT, 'data', 'dutyhub.db');
const UPLOAD_ROOT = path.join(TMP_ROOT, 'uploads');
process.env.DUTYHUB_DATA = path.join(TMP_ROOT, 'data');
process.env.DUTYHUB_UPLOADS = UPLOAD_ROOT;

// Изолированная база и каталог загрузок — тесты не трогают рабочие данные
fs.mkdirSync(path.join(TMP_ROOT, 'data'), { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DUTYHUB_DATA: process.env.DUTYHUB_DATA,
    DUTYHUB_UPLOADS: process.env.DUTYHUB_UPLOADS,
    DUTYHUB_SECRET: 'test-secret-key-for-deterministic-csrf-0001',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

test.after(() => {
  server.kill();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
});

async function waitForServer() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* ещё не поднялся */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Сервер не поднялся:\n${serverLog}`);
}

/* ─────────── минимальный HTTP-клиент с cookie-jar и CSRF ─────────── */
class Client {
  constructor() { this.cookies = new Map(); this.csrf = null; }

  header() {
    const h = { 'X-Requested-With': 'dutyhub' };
    if (this.csrf) h['X-CSRF-Token'] = this.csrf;
    return h;
  }

  cookieString() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    const raw = res.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }

  async raw(method, url, { body, headers = {}, raw } = {}) {
    const h = { ...this.header(), ...headers };
    if (this.cookies.size) h.Cookie = this.cookieString();
    let payload = body;
    if (body && !(body instanceof FormData)) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${url}`, { method, headers: h, body: payload, redirect: 'manual' });
    this.absorb(res);
    let data = null;
    const ct = res.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) data = await res.json();
    else data = raw ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, data, headers: res.headers };
  }

  get(url, o) { return this.raw('GET', url, o); }
  post(url, body, o) { return this.raw('POST', url, { body, ...o }); }
  put(url, body, o) { return this.raw('PUT', url, { body, ...o }); }
  patch(url, body, o) { return this.raw('PATCH', url, { body, ...o }); }
  del(url, o) { return this.raw('DELETE', url, o); }

  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    if (r.status === 200) this.csrf = r.data.csrfToken;
    return r;
  }
}

/** Минимальный валидный PNG (1×1). */
function pngBytes() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
}
function avatarBlob() {
  return new Blob([pngBytes()], { type: 'image/png' });
}
function photoBlob() {
  return new Blob([pngBytes()], { type: 'image/png' });
}

let anon; let starosta; let kurator; let otvet1; let otvet2; let member1;

test('сервер поднимается и заполняет базу', async () => {
  await waitForServer();
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  const health = await r.json();
  assert.equal(health.ok, true);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const teams = db.prepare('SELECT COUNT(*) c FROM teams').get().c;
  const duties = db.prepare('SELECT COUNT(*) c FROM duties').get().c;
  db.close();
  // В сиде только staff-аккаунты: учеников владелец класса заводит сам.
  assert.equal(users, 2, `ожидались только starosta и kurator, получено ${users}`);
  assert.equal(teams, 5);
  assert.ok(duties > 15, `ожидалось много дежурств, получено ${duties}`);
});

/* ══════════════ 1. Регистрация ══════════════ */
test('bootstrap отдаёт настройки класса без авторизации', async () => {
  anon = new Client();
  const r = await anon.get('/api/auth/bootstrap');
  assert.equal(r.status, 200);
  assert.equal(r.data.authenticated, false);
  assert.equal(r.data.classInfo.name, '5 «Г»');
  assert.equal(r.data.canRegister, true);
});

/** Коды приглашения читаются напрямую из БД теста. */
function inviteCode(key) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  db.close();
  assert.ok(row?.value, `в настройках нет ключа ${key}`);
  return row.value;
}

function regForm({ role = 'member', username, code, teamId, avatar = avatarBlob(), password = 'parol123' }) {
  const fd = new FormData();
  if (role) fd.set('role', role);
  fd.set('username', username);
  fd.set('password', password);
  fd.set('firstName', 'Тест');
  fd.set('lastName', 'Тестов');
  if (code) fd.set('code', code);
  if (teamId) fd.set('teamId', teamId);
  if (avatar) fd.set('avatar', avatar, 'a.png');
  return fd;
}

test('регистрация без кода не даёт роль «староста»', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ role: 'starosta', username: 'hacker1' }) });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'BAD_INVITE_CODE');
});

test('регистрация без кода не даёт роль «куратор»', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ role: 'curator', username: 'hacker2' }) });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'BAD_INVITE_CODE');
});

test('неверный код приглашения отклоняется', async () => {
  const c = new Client();
  for (const role of ['starosta', 'curator']) {
    const r = await c.raw('POST', '/api/auth/register', {
      body: regForm({ role, username: `wrongcode-${role}`, code: '0000-НЕТ-ТАКОГО' }),
    });
    assert.equal(r.status, 403, `${role}: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, 'BAD_INVITE_CODE');
  }
});

test('верный код приглашения регистрирует куратора', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', {
    body: regForm({ role: 'curator', username: 'kurator2', code: inviteCode('invite_code_curator') }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'curator');
  assert.ok(r.data.permissions.includes('photo.review'));
  assert.ok(!r.data.permissions.includes('settings.manage'));
});

test('верный код приглашения регистрирует старосту', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', {
    body: regForm({ role: 'starosta', username: 'starosta2', code: inviteCode('invite_code_starosta') }),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'starosta');
  assert.ok(r.data.permissions.includes('settings.manage'));
});

test('регистрация требует фото профиля', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ username: 'nophoto1', avatar: null }) });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /фото/i);
});

test('регистрация больше не требует команду — ученик приходит без неё', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ username: 'noteam1' }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'member');
  assert.equal(r.data.user.teamNumber, null);
  assert.equal(r.data.user.teamId, null);
});

test('регистрация отвечает 400 на неимиджевое «изображение»', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', {
    body: regForm({
      username: 'fakeimg1',
      avatar: new Blob([Buffer.from('#!/bin/sh' + String.fromCharCode(10) + 'echo hi')], { type: 'image/png' }),
    }),
  });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, 'BAD_FILE');
});

test('успешная регистрация создаёт ученика без команды и открывает сессию', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ username: 'novichok1' }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.user.role, 'member');
  assert.equal(r.data.user.teamId, null);
  assert.ok(r.data.csrfToken);
  assert.ok(!r.data.permissions.includes('user.edit'));
  assert.ok(!r.data.permissions.includes('settings.manage'));
  c.csrf = r.data.csrfToken;

  const again = new Client();
  const r2 = await again.login('novichok1', 'parol123');
  assert.equal(r2.status, 200);
});

test('повторная регистрация того же логина отклоняется', async () => {
  const c = new Client();
  const r = await c.raw('POST', '/api/auth/register', { body: regForm({ username: 'novichok1' }) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'LOGIN_TAKEN');
});

/* ══════════════ 2. Вход / выход / сессия ══════════════ */
test('вход неверным паролем не проходит', async () => {
  const c = new Client();
  const r = await c.login('starosta', 'неверный');
  assert.equal(r.status, 401);
  assert.equal(r.data.code, 'BAD_CREDENTIALS');
});

test('вход всех трёх ролей работает', async () => {
  starosta = new Client();
  kurator = new Client();
  otvet1 = new Client();
  otvet2 = new Client();
  member1 = new Client();
  const a = await starosta.login('starosta', 'starosta');
  const b = await kurator.login('kurator', 'kurator');
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 200, JSON.stringify(b.data));

  // В сиде остались только staff-аккаунты, поэтому учеников для проверок
  // прав создаём сами — ровно так же, как это делает владелец класса.
  const mk = async (username, firstName, lastName, role, teamId) => {
    const r = await starosta.post('/api/users', {
      username, password: 'test1234', firstName, lastName, role, teamId,
    });
    assert.equal(r.status, 201, `${username}: ${JSON.stringify(r.data)}`);
    return r.data.user;
  };
  await mk('otvet1', 'Смирнов', 'Никита', 'responsible', 1);
  await mk('otvet2', 'Зайцев', 'Роман', 'responsible', 2);
  await mk('u01', 'Абрамова', 'Виктория', 'member', 1);
  await mk('u02', 'Белов', 'Артём', 'member', 2);
  await mk('u05', 'Хохлова', 'Алиса', 'member', 4);

  const c = await otvet1.login('otvet1', 'test1234');
  const d = await otvet2.login('otvet2', 'test1234');
  const e = await member1.login('u01', 'test1234');
  for (const r of [c, d, e]) assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(a.data.user.role, 'starosta');
  assert.equal(b.data.user.role, 'curator');
  assert.equal(c.data.user.role, 'responsible');
  assert.equal(e.data.user.role, 'member');
});

test('сессия сохраняется при повторном запросе (как после F5)', async () => {
  const c = new Client();
  c.cookies = new Map(starosta.cookies); c.csrf = starosta.csrf;
  const r = await c.get('/api/auth/me');
  assert.equal(r.status, 200);
  assert.equal(r.data.authenticated, true);
  assert.equal(r.data.user.username, 'starosta');
  assert.ok(r.data.csrfToken);
  // CSRF-токен стабилен между запросами
  const r2 = await c.get('/api/auth/me');
  assert.equal(r.data.csrfToken, r2.data.csrfToken);
});

test('выход уничтожает сессию', async () => {
  const c = new Client();
  await c.login('starosta', 'starosta');
  assert.equal((await c.get('/api/auth/me')).data.authenticated, true);
  const out = await c.post('/api/auth/logout');
  assert.equal(out.status, 200);
  const r = await c.get('/api/auth/me');
  assert.equal(r.data.authenticated, false, 'после выхода сессия не работает');

  // Выход не трогает другие устройства/сессии того же пользователя
  assert.equal((await starosta.get('/api/auth/me')).data.authenticated, true,
    'выход в одном окне не выкидывает из другого');
  // Повторный вход выдаёт новую рабочую сессию
  const again = new Client();
  await again.login('starosta', 'starosta');
  assert.equal((await again.get('/api/auth/me')).data.authenticated, true);
});

test('подделка cookie сессии не даёт доступ', async () => {
  const c = new Client();
  c.cookies.set('dh_session', 'abc.def');
  const r = await c.get('/api/auth/me');
  assert.equal(r.data.authenticated, false);
  const r2 = await c.get('/api/duties');
  assert.equal(r2.status, 401);
});

test('без авторизации API закрыт', async () => {
  const c = new Client();
  for (const ep of ['/api/duties', '/api/teams', '/api/users', '/api/messages', '/api/photos', '/api/stats/overview', '/api/system/overview']) {
    const r = await c.get(ep);
    assert.equal(r.status, 401, `${ep} должен требовать авторизацию`);
  }
});

/* ══════════════ 3. CSRF ══════════════ */
test('изменяющий запрос без CSRF-токена отклоняется', async () => {
  const c = new Client();
  c.cookies = new Map(starosta.cookies); // намеренно без CSRF-токена
  const r = await c.raw('POST', '/api/messages', { body: { title: 'взлом', body: 'взлом', audience: 'class' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'BAD_CSRF');
});

test('изменяющий запрос с чужим CSRF-токеном отклоняется', async () => {
  const c = new Client();
  c.cookies = new Map(starosta.cookies); c.csrf = starosta.csrf;
  c.csrf = kurator.csrf;
  const r = await c.post('/api/messages', { title: 'взлом', body: 'взлом', audience: 'class' });
  assert.equal(r.status, 403);
});

/* ══════════════ 4. Роли и права ══════════════ */
test('панели: у каждой роли свой набор прав', async () => {
  const s = (await starosta.get('/api/auth/me')).data;
  const k = (await kurator.get('/api/auth/me')).data;
  const o = (await otvet1.get('/api/auth/me')).data;
  const m = (await member1.get('/api/auth/me')).data;

  assert.ok(s.permissions.includes('user.block'));
  assert.ok(s.permissions.includes('settings.manage'));
  assert.ok(s.permissions.includes('team.assign'));
  assert.ok(s.permissions.includes('duty.delete'));

  assert.ok(!k.permissions.includes('settings.manage'), 'куратор не видит технические настройки');
  assert.ok(!k.permissions.includes('audit.view'), 'куратор не видит журнал системы');
  assert.ok(!k.permissions.includes('user.block'), 'куратор не блокирует аккаунты');
  assert.ok(!k.permissions.includes('duty.delete'));
  assert.ok(k.permissions.includes('message.broadcast'));
  assert.ok(k.permissions.includes('duty.schedule'));

  assert.ok(!o.permissions.includes('user.edit'));
  assert.ok(!o.permissions.includes('message.send'), 'ответственный не пишет сообщения');
  assert.ok(!o.permissions.includes('team.edit'));
  assert.ok(!o.permissions.includes('settings.manage'));
  assert.ok(o.permissions.includes('duty.mark.team'));
  assert.ok(o.permissions.includes('photo.upload'));

  assert.ok(!m.permissions.includes('photo.view.team'));
  assert.ok(!m.permissions.includes('duty.mark.team'));
});

test('куратор не попадает в технические настройки (HTTP 403)', async () => {
  const r = await kurator.get('/api/system/settings');
  assert.equal(r.status, 403);
  const a = await kurator.get('/api/system/audit');
  assert.equal(a.status, 403);
  const s = await starosta.get('/api/system/settings');
  assert.equal(s.status, 200);
  assert.ok(s.data.fields.length > 0);
});

test('ответственный не может создать/изменить чужого пользователя', async () => {
  const r = await otvet1.post('/api/users', { username: 'x1', firstName: 'А', lastName: 'Б' });
  assert.equal(r.status, 403);
  const list = await otvet1.get('/api/users');
  assert.equal(list.status, 403);
});

test('куратор не может редактировать пользователей', async () => {
  const r = await kurator.patch('/api/users/1', { firstName: 'Взлом' });
  assert.equal(r.status, 403);
});

/* ══════════════ 5. Профиль: нельзя открыть чужой / сменить роль ══════════════ */
test('профиль: нельзя изменить себе роль через PATCH профиля', async () => {
  const r = await otvet1.patch('/api/auth/profile', { firstName: 'Ответственный', lastName: 'Тестовый', role: 'starosta', teamId: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.role, 'responsible');
  assert.equal(r.data.user.teamNumber, 1, 'команда не должна меняться через личный профиль');
});

test('профиль: нельзя стать блокированным через личный профиль', async () => {
  const r = await otvet1.patch('/api/auth/profile', { firstName: 'Ответственный', lastName: 'Тестовый', isActive: false });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isActive, true);
});

test('староста не может изменить собственную роль или себя заблокировать', async () => {
  const r = await starosta.patch('/api/users/1', { role: 'member' });
  assert.equal(r.status, 403);
  const b = await starosta.post('/api/users/1/block', { blocked: true });
  assert.equal(b.status, 403);
  const me = await starosta.get('/api/auth/me');
  assert.equal(me.data.user.role, 'starosta');
});

test('понизить роль можно только если старост не последний', async () => {
  const fd = new FormData();
  fd.set('role', 'starosta');
  fd.set('username', 'starostaX');
  fd.set('password', 'starostaX1');
  fd.set('firstName', 'Третий');
  fd.set('lastName', 'Староста');
  fd.set('avatar', avatarBlob(), 'a.png');
  const created = await starosta.raw('POST', '/api/users', { body: fd });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const newId = created.data.user.id;
  // старост теперь не последний — понизить можно
  const ok = await starosta.patch('/api/users/' + newId, { role: 'member' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.role, 'member');
});

test('блокировка аккаунта закрывает его сессии', async () => {
  const victim = new Client();
  await victim.login('u05', 'test1234');
  const before = await victim.get('/api/auth/me');
  assert.equal(before.data.authenticated, true);

  const users = (await starosta.get('/api/users?q=u05')).data.users;
  const target = users.find((u) => u.username === 'u05');
  assert.ok(target);

  const block = await starosta.post(`/api/users/${target.id}/block`, { blocked: true });
  assert.equal(block.status, 200);
  assert.equal(block.data.user.isActive, false);

  const after = await victim.get('/api/auth/me');
  assert.equal(after.data.authenticated, false, 'сессия заблокированного не должна работать');

  const reLogin = await victim.login('u05', 'test1234');
  assert.equal(reLogin.status, 403);
  assert.equal(reLogin.data.code, 'ACCOUNT_BLOCKED');

  await starosta.post(`/api/users/${target.id}/block`, { blocked: false });
  const back = await victim.login('u05', 'test1234');
  assert.equal(back.status, 200);
});

/* ══════════════ 6. Команды ══════════════ */
test('команды видны всем авторизованным, карточка содержит участников', async () => {
  const r = await starosta.get('/api/teams');
  assert.equal(r.status, 200);
  assert.equal(r.data.teams.length, 5);

  // В сиде команды пустые — состав появляется только после назначения.
  const byNumber = new Map(r.data.teams.map((t) => [t.number, t]));
  const t1 = byNumber.get(1);
  const t2 = byNumber.get(2);

  assert.equal(t1.responsible?.username, 'otvet1', 'otvet1 должен стать ответственным команды №1');
  assert.equal(t2.responsible?.username, 'otvet2', 'otvet2 должен стать ответственным команды №2');
  assert.ok(t1.members.length >= 2, `в команде №1 должно быть минимум 2 участника, получено ${t1.members.length}`);

  const untouched = r.data.teams.find((t) => t.members.length === 0);
  assert.ok(untouched, 'хотя бы одна команда остаётся пустой');
  assert.equal(untouched.responsible, null, 'у пустой команды нет ответственного');

  const mine = await otvet1.get('/api/teams/mine');
  assert.equal(mine.status, 200);
  assert.equal(mine.data.team.number, 1);
  assert.equal(mine.data.isResponsible, true);
  assert.ok(mine.data.members.length > 0);
});

test('состав команды может менять только староста (куратор может по праву состава)', async () => {
  const teams = (await starosta.get('/api/teams')).data.teams;
  const team3 = teams.find((t) => t.number === 3);
  const memberIds = team3.members.map((m) => m.id);

  const r1 = await otvet1.get('/api/teams');
  assert.equal(r1.status, 200, 'ответственный видит список команд');
  const r2 = await otvet1.patch(`/api/teams/${team3.id}`, { name: 'Взлом' });
  assert.equal(r2.status, 403, 'ответственный не может переименовать чужую команду');
  const r3 = await otvet1.put(`/api/teams/${team3.id}/responsible`, { userId: 3 });
  assert.equal(r3.status, 403, 'ответственный не может назначить себя');

  const r4 = await kurator.put(`/api/teams/${team3.id}/responsible`, { userId: 5 });
  assert.equal(r4.status, 403, 'куратор не может назначать ответственных');
  const r5 = await starosta.put(`/api/teams/${team3.id}/responsible`, { userId: 5 });
  assert.equal(r5.status, 200);
  assert.equal(r5.data.team.responsibleId, 5);
  // возвращаем как было
  await starosta.put(`/api/teams/${team3.id}/responsible`, { userId: team3.responsibleId });
  const r6 = await kurator.put(`/api/teams/${team3.id}/members`, { memberIds });
  assert.equal(r6.status, 200, 'куратор может корректировать состав');
});

/* ══════════════ 7. Дежурства и календарь ══════════════ */
test('календарь отдаёт сетку месяца со статусами', async () => {
  const r = await starosta.get('/api/duties/calendar');
  assert.equal(r.status, 200);
  assert.ok(r.data.duties.length > 0);
  assert.ok(r.data.teams.length === 5);
  for (const d of r.data.duties) {
    assert.ok(['planned', 'pending', 'done', 'missed'].includes(d.status));
    assert.ok(d.weekday && d.humanDate);
    assert.ok(d.teamNumber >= 1 && d.teamNumber <= 5);
  }
  // фильтр: только сегодня
  const today = await starosta.get('/api/duties?scope=today');
  const t = (await starosta.get('/api/stats/overview')).data.today;
  assert.ok(today.data.duties.every((d) => d.date === t));
  const week = await starosta.get('/api/duties?scope=week');
  assert.equal(week.status, 200);
  const next = await starosta.get('/api/duties?scope=next_week');
  assert.equal(next.status, 200);
  const month = await starosta.get('/api/duties?scope=month');
  assert.equal(month.status, 200);
});

test('староста создаёт дежурство, куратор не может его удалить', async () => {
  const today = (await starosta.get('/api/stats/overview')).data.today;
  const date = new Date(today);
  date.setDate(date.getDate() + 40);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const bad1 = await otvet1.post('/api/duties', { date: iso, teamId: 1 });
  assert.equal(bad1.status, 403, 'ответственный не создаёт дежурства');

  const created = await starosta.post('/api/duties', { date: iso, teamId: 2, dutyTime: '07:30 · Вестибюль' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const dutyId = created.data.duty.id;
  assert.equal(created.data.duty.status, 'planned');

  // дубль даты
  const dup = await starosta.post('/api/duties', { date: iso, teamId: 3 });
  assert.equal(dup.status, 409);

  // куратор правит расписание
  const edited = await kurator.patch(`/api/duties/${dutyId}`, { dutyTime: '07:45 · Вестибюль' });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.duty.dutyTime, '07:45 · Вестибюль');
  assert.ok(edited.data.members.length > 0, 'у дежурства должны появиться отметки участников');

  // ответственный чужой команды не может отмечать
  const detail = await starosta.get(`/api/duties/${dutyId}`);
  const member = detail.data.members[0];
  const wrong = await otvet1.put(`/api/duties/${dutyId}/marks/${member.id}`, { mark: 'served' });
  assert.equal(wrong.status, 403);

  // куратор не удаляет
  const delByKurator = await kurator.del(`/api/duties/${dutyId}`);
  assert.equal(delByKurator.status, 403);
  // стар��ста удаляет
  const delByStarosta = await starosta.del(`/api/duties/${dutyId}`);
  assert.equal(delByStarosta.status, 200);
});

/* ══════════════ 8. Отметки ══════════════ */
test('ответственный отмечает участников своей команды', async () => {
  const mine = (await otvet1.get('/api/teams/mine')).data;
  const todayDuty = (await starosta.get('/api/duties?scope=today')).data.duties
    .find((d) => d.teamNumber === 1);
  if (!todayDuty) return; // сегодня команда №1 не дежурит — проверка ниже на истории
  const detail = await otvet1.get(`/api/duties/${todayDuty.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.viewer.canManage, true);
  const m = detail.data.members[0];
  const r = await otvet1.put(`/api/duties/${todayDuty.id}/marks/${m.id}`, { mark: 'served', note: 'убирал' });
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const found = r.data.marks.find((x) => x.id === m.id);
  assert.equal(found.mark, 'served');
  assert.equal(found.note, 'убирал');

  const bad = await otvet1.put(`/api/duties/${todayDuty.id}/marks/${m.id}`, { mark: 'вышел' });
  assert.equal(bad.status, 400, 'некорректная отметка отклоняется');
});

test('отметки видны по-разному: статусы 🟢🔴🟡 поддержаны', async () => {
  const duties = (await starosta.get('/api/duties?scope=week')).data.duties;
  const withDuty = duties[0];
  const detail = await starosta.get(`/api/duties/${withDuty.id}`);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.members));
  assert.ok(detail.data.members.every((m) => ['present', 'absent', 'unmarked', 'served', 'not_served'].includes(m.mark)));
  assert.ok(detail.data.members.every((m) => m.markLabel));
});

test('история дежурств пользователя доступна', async () => {
  // В пустом сиде отметок нет — создаём дежурство и отмечаемся в нём сами.
  const base = new Date((await starosta.get('/api/stats/overview')).data.today);
  const past = new Date(base); past.setDate(past.getDate() - 37);
  const iso = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-${String(past.getDate()).padStart(2, '0')}`;
  const created = await starosta.post('/api/duties', { date: iso, teamId: 1, dutyTime: '09:00 · История' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const dutyId = created.data.duty.id;

  const me = (await otvet1.get('/api/auth/me')).data.user;
  const marked = await otvet1.put(`/api/duties/${dutyId}/marks/${me.id}`, { mark: 'served' });
  assert.equal(marked.status, 200, JSON.stringify(marked.data));

  const r = await otvet1.get('/api/duties/my/history');
  assert.equal(r.status, 200);
  assert.ok(r.data.duties.length > 0, 'у ответственного есть история дежурств');
  assert.ok(r.data.duties.some((x) => x.id === dutyId), 'отмеченное дежурство попало в историю');
  assert.ok(r.data.stats);
  assert.equal(r.data.stats.served, 1);
  const next = await otvet1.get('/api/duties/my/next');
  assert.equal(next.status, 200);
});

/* ══════════════ 9. Фотографии ══════════════ */
test('загрузка фото, проверка и права видимости', async () => {
  // Создаём отдельное дежурство команды №1, чтобы сценарий был однозначным
  const base = new Date((await starosta.get('/api/stats/overview')).data.today);
  const d = new Date(base); d.setDate(d.getDate() + 60);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const created = await starosta.post('/api/duties', { date: iso, teamId: 1, dutyTime: '09:00 · Фото-тест' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const dutyId = created.data.duty.id;

  const fd = new FormData();
  fd.set('dutyId', String(dutyId));
  fd.set('photo', photoBlob(), 'posle-uborki.png');
  const up = await otvet1.raw('POST', '/api/photos', { body: fd });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.equal(up.data.photo.checkStatus, 'pending');
  const photoId = up.data.photo.id;
  assert.equal(up.data.photo.uploadedBy.username, 'otvet1');

  // Дежурство ушло на проверку
  const afterUpload = await starosta.get(`/api/duties/${dutyId}`);
  assert.equal(afterUpload.data.duty.status, 'pending');

  // Файл отдаётся автору
  const fileRes = await otvet1.get(`/api/files/photo/${photoId}`, { raw: true });
  assert.equal(fileRes.status, 200);
  assert.ok(fileRes.data.length > 0);

  // Чужой ответственный чужое фото не видит
  const denied = await otvet2.get(`/api/files/photo/${photoId}`);
  assert.equal(denied.status, 403, 'чужое фото недоступно');
  assert.equal(denied.data.code, 'FORBIDDEN');

  // Анонимно — 401
  const anonRes = await new Client().get(`/api/files/photo/${photoId}`);
  assert.equal(anonRes.status, 401);

  // Ученик без прав не видит галерею
  assert.equal((await member1.get('/api/photos')).status, 403);

  // Ответственный подтвердить фото не может
  assert.equal((await otvet1.post(`/api/photos/${photoId}/review`, { status: 'approved' })).status, 403);

  // Куратор подтверждает
  const good = await kurator.post(`/api/photos/${photoId}/review`, { status: 'approved', note: 'Класс чистый' });
  assert.equal(good.status, 200);
  assert.equal(good.data.photo.checkStatus, 'approved');
  assert.equal(good.data.dutyStatus, 'done', 'после проверки дежурство становится выполненным');

  // Теперь фото видно куратору и остальным
  assert.equal((await kurator.get(`/api/files/photo/${photoId}`)).status, 200);
  assert.equal((await starosta.get(`/api/files/photo/${photoId}`)).status, 200);

  // Отклонение фото переводит дежурство в «не выполнено»
  const fd2 = new FormData();
  fd2.set('dutyId', String(dutyId));
  fd2.set('photo', photoBlob(), 'p2.png');
  const up2 = await starosta.raw('POST', '/api/photos', { body: fd2 });
  assert.equal(up2.status, 201);
  const reject = await starosta.post(`/api/photos/${up2.data.photo.id}/review`, { status: 'rejected', note: 'грязно' });
  assert.equal(reject.status, 200);
  assert.equal(reject.data.dutyStatus, 'missed');

  // Загрузка не-изображения отклоняется
  const fd3 = new FormData();
  fd3.set('dutyId', String(dutyId));
  fd3.set('photo', new Blob([Buffer.from('<?php system($_GET[0]);')], { type: 'image/png' }), 'evil.png');
  const evil = await starosta.raw('POST', '/api/photos', { body: fd3 });
  assert.equal(evil.status, 400);
  assert.equal(evil.data.code, 'BAD_FILE');

  // Чужой ответственный не может грузить фото к чужому дежурству
  const fd4 = new FormData();
  fd4.set('dutyId', String(dutyId));
  fd4.set('photo', photoBlob(), 'p4.png');
  assert.equal((await otvet2.raw('POST', '/api/photos', { body: fd4 })).status, 403);

  // Галерея ответственного — только своя команда
  const gal = await otvet1.get('/api/photos');
  assert.equal(gal.status, 200);
  assert.ok(gal.data.photos.every((p) => p.team?.number === 1), 'в галерее только фото своей команды');
  assert.equal(gal.data.canReview, false);
  assert.equal((await kurator.get('/api/photos')).data.canReview, true);
});

/* ══════════════ 10. Сообщения ══════════════ */
test('сообщения: адресаты и права', async () => {
  // ответственный писать не может
  const denied = await otvet1.post('/api/messages', { title: 'Привет', body: 'Текст', audience: 'class' });
  assert.equal(denied.status, 403);

  // куратор объявляет всему классу
  const notice = await kurator.post('/api/messages', {
    title: 'Завтра дежурит команда №2', body: 'Не забудьте прийти вовремя.', audience: 'class', kind: 'notice',
  });
  assert.equal(notice.status, 201, JSON.stringify(notice.data));
  const noticeId = notice.data.message.id;

  // ответственный видит объявление
  const feed = await otvet1.get('/api/messages');
  assert.equal(feed.status, 200);
  assert.ok(feed.data.messages.some((m) => m.id === noticeId));
  assert.equal(feed.data.canSend, false);

  // куратор может
  assert.equal(feed.data.canSend, false, 'у ответственного кнопки нет');

  // личное сообщение ответственному команды №1
  const me = (await otvet1.get('/api/auth/me')).data.user;
  const personal = await starosta.post('/api/messages', {
    title: 'Лично', body: 'Проверь расписание', audience: 'user', targetUserId: me.id,
  });
  assert.equal(personal.status, 201);
  assert.ok((await otvet1.get('/api/messages')).data.messages.some((m) => m.id === personal.data.message.id));
  assert.ok(!(await otvet2.get('/api/messages')).data.messages.some((m) => m.id === personal.data.message.id),
    'личное сообщение не должно попасть к другому ответственному');

  // сообщение команде
  const teams = (await starosta.get('/api/teams')).data.teams;
  const team1 = teams.find((t) => t.number === 1);
  const toTeam = await starosta.post('/api/messages', {
    title: 'Команда №1', body: 'Соберитесь у кабинета', audience: 'team', teamId: team1.id,
  });
  assert.equal(toTeam.status, 201);
  assert.ok((await otvet1.get('/api/messages')).data.messages.some((m) => m.id === toTeam.data.message.id));
  assert.ok(!(await otvet2.get('/api/messages')).data.messages.some((m) => m.id === toTeam.data.message.id));

  // прочитано / не прочитано
  const unreadBefore = (await otvet1.get('/api/messages/unread-count')).data.count;
  assert.ok(unreadBefore > 0);
  await otvet1.post(`/api/messages/${noticeId}/read`);
  const unreadAfter = (await otvet1.get('/api/messages/unread-count')).data.count;
  assert.equal(unreadAfter, unreadBefore - 1);

  // непрочитаемое чужое сообщение
  const deniedRead = await otvet2.post(`/api/messages/${personal.data.message.id}/read`);
  assert.equal(deniedRead.status, 403);

  // удаление: автор или менеджер
  const delOther = await otvet1.post('/api/messages', { title: 'x', body: 'y', audience: 'class' });
  assert.equal(delOther.status, 403);
  const delOwn = await kurator.del(`/api/messages/${noticeId}`);
  assert.equal(delOwn.status, 200);
});

/* ══════════════ 11. Защита страниц / SPA ══════════════ */
test('SPA-маршруты отдают index.html и закрыты на уровне API', async () => {
  for (const p of ['/', '/login', '/register', '/duties', '/users/1', '/anything']) {
    const r = await fetch(`${BASE}${p}`);
    assert.equal(r.status, 200, `${p} должен отдавать SPA`);
    const html = await r.text();
    assert.match(html, /DUTY HUB/);
  }
  // каталог uploads не раздаётся статикой
  const leak = await fetch(`${BASE}/uploads/photos/../../data/dutyhub.db`);
  assert.ok(leak.status >= 400, 'доступ к базе через uploads невозможен');
  const raw = await fetch(`${BASE}/data/dutyhub.db`);
  assert.ok(raw.status >= 400, 'база недоступна извне');
});

test('защищённые страницы: чужая сессия не открывает чужой аккаунт', async () => {
  const starostaId = (await starosta.get('/api/auth/me')).data.user.id;
  // Ответственный пытается посмотреть данные панели старосты
  for (const ep of ['/api/system/overview', '/api/system/audit', '/api/system/settings']) {
    const r = await otvet1.get(ep);
    assert.equal(r.status, 403, `${ep} закрыт для ответственного`);
  }
  // Попытка выдать себе роль через админский PATCH
  const meId = (await otvet1.get('/api/auth/me')).data.user.id;
  const escalate = await otvet1.patch(`/api/users/${meId}`, { role: 'starosta' });
  assert.equal(escalate.status, 403);
  const me2 = await otvet1.get('/api/auth/me');
  assert.equal(me2.data.user.role, 'responsible');
  assert.notEqual(me2.data.user.id, starostaId);
});

/* ══════════════ 12. Смена пароля ══════════════ */
test('смена пароля закрывает другие сессии и требует верный текущий', async () => {
  const first = new Client();
  await first.login('u01', 'test1234');
  const second = new Client();
  await second.login('u01', 'test1234');

  const wrong = await first.post('/api/auth/password', { currentPassword: 'неверный', newPassword: 'novyparol1' });
  assert.equal(wrong.status, 400);

  const ok = await first.post('/api/auth/password', { currentPassword: 'test1234', newPassword: 'novyparol1' });
  assert.equal(ok.status, 200);
  first.csrf = ok.data.csrfToken;

  const other = await second.get('/api/auth/me');
  assert.equal(other.data.authenticated, false, 'прошлая сессия должна быть закрыта');

  const reLogin = await new Client().login('u01', 'novyparol1');
  assert.equal(reLogin.status, 200);
  const old = await new Client().login('u01', 'test1234');
  assert.equal(old.status, 401);
});

/* ══════════════ 13. Валидация ══════════════ */
test('сервер валидирует входные данные', async () => {
  const cases = [
    ['/api/messages', { title: '', body: 'тест', audience: 'class' }, 400],
    ['/api/messages', { title: 'ок', body: 'x', audience: 'нет-такой' }, 400],
    ['/api/duties', { date: '31-31-2020', teamId: 1 }, 400],
    ['/api/duties', { date: '2020-13-45', teamId: 1 }, 400],
    ['/api/duties', { date: new Date().toISOString().slice(0, 10), teamId: 999 }, 400],
  ];
  for (const [url, body, expected] of cases) {
    const r = await kurator.post(url, body);
    assert.equal(r.status, expected, `${url} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.data)}`);
  }
  // несуществующие сущности
  assert.equal((await starosta.get('/api/duties/999999')).status, 404);
  assert.equal((await starosta.get('/api/teams/999999')).status, 404);
  assert.equal((await starosta.get('/api/users/999999')).status, 404);
});

test('карточка сотрудника без команды открывается (starosta/kurator team_id пуст)', async () => {
  // Регрессия: u.team_id = NULL давал `undefined` в параметр SQLite → 500.
  const staffRows = (await starosta.get('/api/users?q=starosta')).data.users;
  const me = staffRows.find((u) => u.username === 'starosta');
  assert.ok(me, 'староста должен быть в каталоге');
  assert.equal(me.teamId, null, 'у старосты нет команды');

  for (const viewer of [starosta, kurator]) {
    const r = await viewer.get(`/api/users/${me.id}`);
    assert.equal(r.status, 200, `карточка старосты: ${r.status} ${JSON.stringify(r.data)}`);
    assert.equal(r.data.user.username, 'starosta');
    assert.deepEqual(r.data.duties, [], 'без команды список дежурств пуст, а не 500');
  }
});

/* ══════════════ 14. Итоговая сводка ══════════════ */
test('панели старосты и куратора содержат ключевые счётчики', async () => {
  const s = await starosta.get('/api/stats/overview');
  assert.equal(s.status, 200);
  for (const k of ['students', 'responsibles', 'dutiesToday', 'doneToday', 'pendingToday']) {
    assert.ok(typeof s.data.counters[k] === 'number', `нет счётчика ${k}`);
  }
  assert.ok(s.data.teamStats.length === 5);
  assert.ok(s.data.weekDuties.length > 0);

  const k = await kurator.get('/api/stats/overview');
  assert.equal(k.status, 200);
  assert.ok(k.data.counters.students > 0);
  assert.ok(!('topAbsences' in k.data) === false); // куратор видит аналитику

  const o = await otvet1.get('/api/stats/overview');
  assert.equal(o.status, 200);
  assert.ok(o.data.myTeam, 'у ответственного есть блок своей команды');
  assert.equal(o.data.myTeam.isResponsible, true);
  assert.ok(o.data.myTeam.members.length > 0);
  assert.ok(o.data.myStats);
  assert.ok(!('teamStats' in o.data));
});
