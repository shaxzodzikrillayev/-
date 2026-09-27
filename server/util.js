/**
 * Утилиты: валидация входных данных, работа с датами, сериализация сущностей.
 * Все данные из req.body проходят через sanitize/valid здесь — «сырых» полей
 * в базу не попадает.
 */
import path from 'node:path';
import { q } from './db.js';

export class HttpError extends Error {
  constructor(status, message, code = 'ERROR', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (msg, code = 'BAD_REQUEST', extra = {}) => new HttpError(400, msg, code, extra);
export const forbidden = (msg = 'Недостаточно прав', code = 'FORBIDDEN') => new HttpError(403, msg, code);
export const notFound = (msg = 'Не найдено') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg, code = 'CONFLICT') => new HttpError(409, msg, code);

export function str(value, field, { min = 0, max = 500, required = true, trim = true } = {}) {
  let v = value === undefined || value === null ? '' : String(value);
  if (trim) v = v.trim();
  if (!v) {
    if (required) throw bad(`Поле «${field}» обязательно`, 'VALIDATION');
    return '';
  }
  if ([...v].length < min) throw bad(`Поле «${field}»: минимум ${min} символов`, 'VALIDATION');
  if ([...v].length > max) throw bad(`Поле «${field}»: максимум ${max} символов`, 'VALIDATION');
  if (/<[^>]*>|javascript:/i.test(v)) throw bad(`Поле «${field}»: недопустимые символы`, 'VALIDATION');
  return v;
}

export function int(value, field, { min = -Infinity, max = Infinity, required = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw bad(`Поле «${field}» обязательно`, 'VALIDATION');
    return fallback;
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw bad(`Поле «${field}» должно быть целым числом`, 'VALIDATION');
  if (n < min || n > max) throw bad(`Поле «${field}»: значение вне допустимого диапазона`, 'VALIDATION');
  return n;
}

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;
export function username(value) {
  const v = str(value, 'Логин', { min: 3, max: 24 }).toLowerCase();
  if (!USERNAME_RE.test(v)) {
    throw bad('Логин: 3–24 символа, только латиница, цифры, «_», «.», «-»', 'VALIDATION');
  }
  return v;
}

const NAME_RE = /^[A-Za-zА-Яа-яЁё\s-]+$/u;
export function personName(value, field, { required = true } = {}) {
  const v = str(value, field, { min: 2, max: 40, required });
  if (!v) return '';
  if (!NAME_RE.test(v)) throw bad(`Поле «${field}»: только буквы, пробел и дефис`, 'VALIDATION');
  return v.split(/\s+/).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function dateStr(value, field = 'Дата') {
  const v = str(value, field, { min: 8, max: 10 });
  if (!DATE_RE.test(v)) throw bad(`${field}: формат ГГГГ-ММ-ДД`, 'VALIDATION');
  const d = new Date(`${v}T00:00:00`);
  if (Number.isNaN(d.getTime())) throw bad(`${field}: некорректная дата`, 'VALIDATION');
  return v;
}

export function inOneOf(value, field, list, { required = true } = {}) {
  const v = str(value, field, { required });
  if (!v) return null;
  if (!list.includes(v)) throw bad(`${field}: недопустимое значение`, 'VALIDATION');
  return v;
}

const MARKS = ['present', 'absent', 'unmarked', 'served', 'not_served'];
const STATUSES = ['planned', 'pending', 'done', 'missed'];
const CHECK_STATUSES = ['pending', 'approved', 'rejected'];
const AUDIENCES = ['class', 'team', 'user'];
export { MARKS, STATUSES, CHECK_STATUSES, AUDIENCES };

/* ───────────────────────── даты ───────────────────────── */

export const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
export const WEEKDAYS_FULL = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const MONTHS_NOM = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function todayStr(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s, days) {
  const d = parseDate(s);
  d.setDate(d.getDate() + days);
  return todayStr(d);
}

export function weekdayOf(s) {
  return parseDate(s).getDay();
}

export function isWeekend(s) {
  const w = weekdayOf(s);
  return w === 0 || w === 6;
}

export function startOfWeek(s, weekStartsMonday = true) {
  const d = parseDate(s);
  const w = d.getDay();
  const diff = weekStartsMonday ? (w === 0 ? -6 : 1 - w) : -w;
  d.setDate(d.getDate() + diff);
  return todayStr(d);
}

export function humanDate(s) {
  if (!DATE_RE.test(String(s))) return String(s ?? '');
  const d = parseDate(s);
  return `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`;
}

export function shortDate(s) {
  if (!DATE_RE.test(String(s))) return String(s ?? '');
  const d = parseDate(s);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function relativeDay(s, now = new Date()) {
  const t = todayStr(now);
  if (s === t) return 'Сегодня';
  if (s === addDays(t, 1)) return 'Завтра';
  if (s === addDays(t, -1)) return 'Вчера';
  return null;
}

export function dutyDateLabel(s, now = new Date()) {
  const rel = relativeDay(s, now);
  if (rel) return `${rel}, ${humanDate(s)}`;
  return `${WEEKDAYS_FULL[weekdayOf(s)]}, ${humanDate(s)}`;
}

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ───────────────────────── сериализация ───────────────────────── */

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    firstName: u.first_name,
    lastName: u.last_name,
    middleName: u.middle_name || '',
    fullName: `${u.last_name} ${u.first_name}${u.middle_name ? ` ${u.middle_name}` : ''}`.trim(),
    shortName: `${u.first_name[0] ?? ''}. ${u.last_name}`,
    // В endpoint всегда есть фото: загруженное или сгенерированное с инициалами
    avatar: `/api/files/avatar/${u.id}`,
    initials: initialsOf(u),
    teamId: u.team_id ?? null,
    teamName: u.team_name ?? null,
    teamNumber: u.team_number ?? null,
    teamColor: u.team_color ?? null,
    isActive: u.is_active === 1,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at ?? null,
  };
}

export function initialsOf(u) {
  const a = (u.first_name?.[0] ?? '').toUpperCase();
  const b = (u.last_name?.[0] ?? '').toUpperCase();
  return `${a}${b}` || '?';
}

export function teamPublic(t, extra = {}) {
  if (!t) return null;
  const members = q.all(
    `SELECT u.*, t2.name AS team_name, t2.number AS team_number, t2.color AS team_color
     FROM users u LEFT JOIN teams t2 ON t2.id = u.team_id
     WHERE u.team_id = ? ORDER BY u.last_name, u.first_name`, t.id,
  );
  return {
    id: t.id,
    number: t.number,
    name: t.name,
    color: t.color,
    title: `Команда №${t.number}`,
    responsibleId: t.responsible_id ?? null,
    responsible: t.responsible_id ? publicUser(q.get(
      `SELECT u.*, tm.name AS team_name, tm.number AS team_number, tm.color AS team_color
       FROM users u LEFT JOIN teams tm ON tm.id = u.team_id WHERE u.id = ?`, t.responsible_id,
    )) : null,
    memberCount: members.length,
    members: members.map(publicUser),
    ...extra,
  };
}

export const DUTY_STATUS_META = {
  planned: { label: 'Запланировано', tone: 'neutral' },
  pending: { label: 'Ожидает проверки', tone: 'warning' },
  done: { label: 'Выполнено', tone: 'success' },
  missed: { label: 'Не выполнено', tone: 'danger' },
};

export const MARK_META = {
  present: { label: 'Присутствовал', short: 'Присутствовал', tone: 'success' },
  absent: { label: 'Отсутствовал', short: 'Отсутствовал', tone: 'danger' },
  unmarked: { label: 'Не отмечен', short: 'Не отмечен', tone: 'neutral' },
  served: { label: 'Дежурил', short: 'Дежурил', tone: 'success' },
  not_served: { label: 'Не дежурил', short: 'Не дежурил', tone: 'warning' },
};

export function dutyPublic(d, opts = {}) {
  if (!d) return null;
  return {
    id: d.id,
    date: d.date,
    dateLabel: dutyDateLabel(d.date),
    humanDate: humanDate(d.date),
    shortDate: shortDate(d.date),
    weekday: WEEKDAYS_FULL[weekdayOf(d.date)],
    weekdayShort: WEEKDAYS_SHORT[weekdayOf(d.date)],
    isToday: d.date === todayStr(),
    isWeekend: isWeekend(d.date),
    teamId: d.team_id,
    teamNumber: d.team_number ?? null,
    teamName: d.team_name ?? null,
    teamColor: d.team_color ?? null,
    responsibleId: d.responsible_id ?? null,
    responsible: d.responsible_id ? publicUser({ ...d, id: d.responsible_id, first_name: d.r_first ?? '', last_name: d.r_last ?? '', middle_name: d.r_middle ?? '', username: d.r_username, role: d.r_role, avatar: d.r_avatar, is_active: 1 }) : null,
    dutyTime: d.duty_time,
    status: d.status,
    statusLabel: DUTY_STATUS_META[d.status]?.label ?? d.status,
    statusTone: DUTY_STATUS_META[d.status]?.tone ?? 'neutral',
    comment: d.comment,
    createdBy: d.created_by ?? null,
    createdAt: d.created_at,
    updatedAt: d.updated_at,
    photoCount: d.photo_count ?? 0,
    pendingPhotoCount: d.pending_photo_count ?? 0,
    ...opts,
  };
}

export const DUTY_SELECT = `
  SELECT d.*, t.name AS team_name, t.number AS team_number, t.color AS team_color,
         ru.first_name AS r_first, ru.last_name AS r_last, ru.middle_name AS r_middle,
         ru.username AS r_username, ru.role AS r_role, ru.avatar AS r_avatar,
         (SELECT COUNT(*) FROM photos p WHERE p.duty_id = d.id) AS photo_count,
         (SELECT COUNT(*) FROM photos p WHERE p.duty_id = d.id AND p.check_status = 'pending') AS pending_photo_count
  FROM duties d
  JOIN teams t ON t.id = d.team_id
  LEFT JOIN users ru ON ru.id = d.responsible_id
`;

/** Только изображения, никаких произвольных путей. */
export function safeFileName(name) {
  return path.basename(String(name)).replace(/[^\w.\-]+/g, '_').slice(0, 120);
}
