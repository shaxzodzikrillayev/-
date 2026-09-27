/**
 * Состояние приложения. Один источник правды для UI.
 * Авторизация — только httpOnly cookie на сервере; здесь хранится лишь
 * публичная копия пользователя, полученная из /api/auth/me.
 */
import { authApi, setCsrfToken, setUnauthorizedHandler, messagesApi } from './api.js';

const listeners = new Set();

export const state = {
  ready: false,
  authenticated: false,
  user: null,
  permissions: new Set(),
  roleLabel: '',
  teams: [],
  classInfo: { name: '5 «Г»', school: '', registrationOpen: true },
  route: { name: 'welcome', params: {} },
  unread: 0,
};

export function can(permission) {
  return state.permissions.has(permission);
}

export function canAny(...perms) {
  return perms.some((p) => state.permissions.has(p));
}

export const isStarosta = () => state.user?.role === 'starosta';
export const isCurator = () => state.user?.role === 'curator';
export const isManager = () => isStarosta() || isCurator();

/** Ответственный ли пользователь за указанную команду. */
export function leadsTeam(teamId) {
  if (!teamId) return false;
  return Boolean(state.teams.find((t) => t.id === teamId && t.responsibleId === state.user?.id));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function emit(reason = 'change') {
  for (const fn of listeners) {
    try { fn(state, reason); } catch (err) { console.error('[store] listener failed', err); }
  }
}

/** Применить payload сессии (login / me / register / profile). */
export function applySession(payload) {
  if (!payload?.authenticated) return clearSession();
  state.authenticated = true;
  state.user = payload.user;
  state.permissions = new Set(payload.permissions ?? []);
  state.roleLabel = payload.roleLabel ?? '';
  state.teams = payload.teams ?? [];
  if (payload.classInfo) state.classInfo = { ...state.classInfo, ...payload.classInfo };
  setCsrfToken(payload.csrfToken ?? null);
  emit('session');
  refreshUnread();
  return state;
}

export function clearSession() {
  state.authenticated = false;
  state.user = null;
  state.permissions = new Set();
  state.roleLabel = '';
  state.teams = [];
  state.unread = 0;
  setCsrfToken(null);
  emit('session');
}

/** Начальная загрузка: проверяем cookie и подтягиваем class info для гостя. */
export async function bootstrap() {
  setUnauthorizedHandler(() => {
    clearSession();
    emit('unauthorized');
  });
  try {
    const [boot, me] = await Promise.all([
      authApi.bootstrap().catch(() => null),
      authApi.me().catch(() => ({ authenticated: false })),
    ]);
    if (boot?.classInfo) state.classInfo = { ...state.classInfo, ...boot.classInfo };
    if (boot?.canRegister !== undefined) state.classInfo.registrationOpen = boot.canRegister;
    if (me?.authenticated) applySession(me);
    else clearSession();
  } finally {
    state.ready = true;
    emit('ready');
  }
}

export async function refreshUnread() {
  if (!state.authenticated || !can('message.view')) {
    state.unread = 0;
    return 0;
  }
  try {
    const { count } = await messagesApi.unreadCount();
    state.unread = count ?? 0;
    emit('unread');
  } catch {
    state.unread = 0;
  }
  return state.unread;
}

export function teamById(id) {
  if (id === null || id === undefined) return null;
  return state.teams.find((t) => t.id === Number(id)) ?? null;
}

export function teamTitle(id) {
  const t = teamById(id);
  return t ? `Команда №${t.number}` : '—';
}
