/**
 * Матрица прав доступа. Единственный источник истины для авторизации —
 * никаких проверок «на клиенте» и «по догадке»: каждое действие на сервере
 * проходит через requirePermission() или resource-guard.
 */
import { q } from './db.js';

export const ROLES = {
  starosta: 'starosta',
  curator: 'curator',
  responsible: 'responsible',
  member: 'member',
};

export const ROLE_LABELS = {
  starosta: 'Староста',
  curator: 'Куратор',
  responsible: 'Ответственный за дежурство',
  member: 'Ученик класса',
};

export const PERMISSIONS = {
  starosta: [
    'duty.view.all', 'duty.create', 'duty.edit', 'duty.delete', 'duty.assign',
    'duty.mark.any', 'duty.mark.team', 'duty.complete', 'duty.comment', 'duty.schedule',
    'photo.view.all', 'photo.view.team', 'photo.upload', 'photo.review', 'photo.delete',
    'message.view', 'message.send', 'message.broadcast', 'message.delete',
    'team.view.all', 'team.edit', 'team.assign', 'team.members',
    'user.view.all', 'user.create', 'user.edit', 'user.block', 'user.reset_password',
    'settings.manage', 'audit.view', 'stats.view.all',
  ],
  curator: [
    'duty.view.all', 'duty.edit', 'duty.mark.any', 'duty.mark.team', 'duty.complete', 'duty.comment', 'duty.schedule',
    'photo.view.all', 'photo.view.team', 'photo.upload', 'photo.review',
    'message.view', 'message.send', 'message.broadcast', 'message.delete',
    'team.view.all', 'team.members',
    'user.view.all',
    'stats.view.all',
  ],
  responsible: [
    'duty.view.all', 'duty.mark.team', 'duty.comment', 'duty.complete.own',
    'photo.view.team', 'photo.upload',
    'message.view',
    'team.view.all', 'team.members',
  ],
  member: [
    'duty.view.all',
    'message.view',
    'team.view.all',
  ],
};

const cache = new Map();
export function permsFor(role) {
  if (!cache.has(role)) cache.set(role, new Set(PERMISSIONS[role] ?? []));
  return cache.get(role);
}

export function can(user, permission) {
  if (!user) return false;
  if (user.is_active === 0) return false;
  return permsFor(user.role).has(permission);
}

export const isManager = (user) => user?.role === ROLES.starosta || user?.role === ROLES.curator;
export const isStarosta = (user) => user?.role === ROLES.starosta;
export const isCurator = (user) => user?.role === ROLES.curator;

/** Ответственный ли пользователь за указанную команду. */
export function leadsTeam(user, teamId) {
  if (!user || !teamId) return false;
  if (user.role === ROLES.responsible) {
    const t = q.get('SELECT responsible_id FROM teams WHERE id = ?', teamId);
    return t?.responsible_id === user.id;
  }
  return false;
}

/** Имеет ли пользователь право работать с этим дежурством (отметки/загрузка фото). */
export function canManageDuty(user, duty) {
  if (!user || !duty) return false;
  if (isManager(user)) return true;
  if (user.role === ROLES.responsible) {
    return duty.responsible_id === user.id
      || duty.team_id === user.team_id
      || leadsTeam(user, duty.team_id);
  }
  return false;
}

/** Видимость фотографии: менеджеры — все, ответственный — своя команда, автор — всегда. */
export function canViewPhoto(user, photo) {
  if (!user || !photo) return false;
  if (isManager(user)) return true;
  if (photo.uploaded_by === user.id) return true;
  if (user.role === ROLES.responsible) {
    if (photo.team_id && photo.team_id === user.team_id) return true;
    return leadsTeam(user, photo.team_id);
  }
  return false;
}

/** Видимость сообщения по адресату. */
export function canViewMessage(user, message) {
  if (!user || !message) return false;
  if (isManager(user)) return true;
  if (message.author_id === user.id) return true;
  if (message.audience === 'class') return true;
  if (message.audience === 'team') {
    if (!message.team_id) return false;
    return message.team_id === user.team_id || leadsTeam(user, message.team_id);
  }
  if (message.audience === 'user') return message.target_user_id === user.id;
  return false;
}

/** Адресаты сообщения (id пользователей) — для отправки уведомлений. */
export function resolveAudience(message) {
  if (message.audience === 'class') {
    return q.all("SELECT id FROM users WHERE role IN ('starosta','curator','responsible','member') AND is_active = 1").map((r) => r.id);
  }
  if (message.audience === 'team') {
    if (!message.team_id) return [];
    return q.all(
      `SELECT u.id FROM users u
       LEFT JOIN teams t ON t.responsible_id = u.id
       WHERE u.is_active = 1 AND (u.team_id = ? OR t.id = ?)`,
      message.team_id, message.team_id,
    ).map((r) => r.id);
  }
  if (message.audience === 'user') {
    return message.target_user_id ? [message.target_user_id] : [];
  }
  return [];
}

/** Публичное представление прав — фронтенд строит UI только по этому списку. */
export function permissionsForClient(user) {
  return [...permsFor(user.role)].sort();
}
