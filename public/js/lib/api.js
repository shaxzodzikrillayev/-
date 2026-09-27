/**
 * HTTP-клиент. Все запросы идут на сервер с cookie-сессией и CSRF-токеном.
 * Никакого хранения авторизации в localStorage — только httpOnly cookie,
 * которую выставил сервер. При 401 клиент корректно разлогинивает пользователя.
 */

export class ApiError extends Error {
  constructor(status, message, code, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

let csrfToken = null;
let onUnauthorized = null;

export function setCsrfToken(token) { csrfToken = token || null; }
export function getCsrfToken() { return csrfToken; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

async function request(method, path, { body, form, signal, skipAuthHandling } = {}) {
  const headers = { 'X-Requested-With': 'dutyhub', Accept: 'application/json' };
  if (MUTATING.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      credentials: 'same-origin',
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new ApiError(0, 'Нет связи с сервером. Проверьте подключение.', 'NETWORK');
  }

  if (res.status === 204) return null;

  const contentType = res.headers.get('content-type') ?? '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    const text = await res.text();
    data = text || null;
  }

  if (!res.ok) {
    const error = new ApiError(
      res.status,
      (data && data.error) || `Ошибка запроса (${res.status})`,
      (data && data.code) || 'ERROR',
      data && typeof data === 'object' ? data : {},
    );
    if (res.status === 401 && !skipAuthHandling) {
      csrfToken = null;
      if (onUnauthorized) onUnauthorized(error);
    }
    throw error;
  }
  return data;
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body, opts) => request('POST', path, { body, ...opts }),
  put: (path, body, opts) => request('PUT', path, { body, ...opts }),
  patch: (path, body, opts) => request('PATCH', path, { body, ...opts }),
  del: (path, opts) => request('DELETE', path, opts),
  upload: (path, form, opts) => request('POST', path, { form, ...opts }),
};

/* ─────────── Сокращения для эндпоинтов ─────────── */
export const authApi = {
  bootstrap: () => api.get('/api/auth/bootstrap'),
  me: () => api.get('/api/auth/me', { skipAuthHandling: true }),
  login: (username, password) => api.post('/api/auth/login', { username, password }),
  register: (formData) => api.upload('/api/auth/register', formData),
  logout: () => api.post('/api/auth/logout', {}),
  updateProfile: (formData) => request('PATCH', '/api/auth/profile', { form: formData }),
  changePassword: (currentPassword, newPassword) =>
    api.post('/api/auth/password', { currentPassword, newPassword }),
  directory: (q = '') => api.get(`/api/auth/directory?q=${encodeURIComponent(q)}`),
  teams: () => api.get('/api/auth/teams'),
};

export const usersApi = {
  list: (params = {}) => api.get(`/api/users?${new URLSearchParams(params)}`),
  get: (id) => api.get(`/api/users/${id}`),
  create: (formData) => api.upload('/api/users', formData),
  update: (id, formData) => request('PATCH', `/api/users/${id}`, { form: formData }),
  block: (id, blocked) => api.post(`/api/users/${id}/block`, { blocked }),
  resetPassword: (id, newPassword) => api.post(`/api/users/${id}/password`, { newPassword }),
  duties: (id, scope = 'all') => api.get(`/api/users/${id}/duties?scope=${scope}`),
};

export const teamsApi = {
  list: () => api.get('/api/teams'),
  mine: () => api.get('/api/teams/mine'),
  get: (id) => api.get(`/api/teams/${id}`),
  create: (body) => api.post('/api/teams', body),
  update: (id, body) => api.patch(`/api/teams/${id}`, body),
  setResponsible: (id, userId) => api.put(`/api/teams/${id}/responsible`, { userId }),
  setMembers: (id, memberIds) => api.put(`/api/teams/${id}/members`, { memberIds }),
  duties: (id, from, to) => api.get(`/api/teams/${id}/duties?from=${from}&to=${to}`),
};

export const dutiesApi = {
  list: (params = {}) => api.get(`/api/duties?${new URLSearchParams(params)}`),
  calendar: (month) => api.get(`/api/duties/calendar?month=${month}`),
  get: (id) => api.get(`/api/duties/${id}`),
  create: (body) => api.post('/api/duties', body),
  update: (id, body) => api.patch(`/api/duties/${id}`, body),
  remove: (id) => api.del(`/api/duties/${id}`),
  mark: (dutyId, userId, mark, note = '') =>
    api.put(`/api/duties/${dutyId}/marks/${userId}`, { mark, note }),
  markBulk: (dutyId, mark, userIds) =>
    api.post(`/api/duties/${dutyId}/marks/bulk`, { mark, userIds }),
  photos: (id) => api.get(`/api/duties/${id}/photos`),
  myHistory: () => api.get('/api/duties/my/history'),
  myNext: () => api.get('/api/duties/my/next'),
};

export const photosApi = {
  list: (params = {}) => api.get(`/api/photos?${new URLSearchParams(params)}`),
  upload: (dutyId, file) => {
    const fd = new FormData();
    fd.set('dutyId', String(dutyId));
    fd.set('photo', file);
    return api.upload('/api/photos', fd);
  },
  review: (id, status, note = '') => api.post(`/api/photos/${id}/review`, { status, note }),
  remove: (id) => api.del(`/api/photos/${id}`),
};

export const messagesApi = {
  list: (params = {}) => api.get(`/api/messages?${new URLSearchParams(params)}`),
  unreadCount: () => api.get('/api/messages/unread-count'),
  create: (body) => api.post('/api/messages', body),
  markRead: (id) => api.post(`/api/messages/${id}/read`, {}),
  remove: (id) => api.del(`/api/messages/${id}`),
};

export const statsApi = {
  overview: () => api.get('/api/stats/overview'),
};

export const systemApi = {
  settings: () => api.get('/api/system/settings'),
  saveSettings: (body) => api.put('/api/system/settings', body),
  audit: (limit = 120) => api.get(`/api/system/audit?limit=${limit}`),
  overview: () => api.get('/api/system/overview'),
};
