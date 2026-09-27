/**
 * Фотографии: загрузка после дежурства, галерея, проверка куратором/старостой.
 * Файлы НЕ раздаются статикой — отдаются только через /api/files/photo/:id
 * с проверкой прав, чтобы чужое фото нельзя было открыть по ссылке.
 */
import express from 'express';
import { q, transaction, audit } from '../db.js';
import { requireAuth, requirePermission, clientIp, rateLimit } from '../middleware.js';
import { uploadPhoto, verifyImage, removeDutyPhoto } from '../uploads.js';
import {
  str, int, dateStr, inOneOf, notFound, forbidden, bad, HttpError, todayStr, addDays,
  CHECK_STATUSES,
} from '../util.js';
import { canManageDuty, canViewPhoto, isManager } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

/* ─────────── POST /api/photos — прикрепить фото к дежурству ─────────── */
router.post(
  '/',
  rateLimit({ limit: 20, windowMs: 10 * 60_000, message: 'Слишком много загрузок. Подождите.' }),
  (req, res, next) => uploadPhoto(req, res, (err) => (err ? next(err) : next())),
  (req, res, next) => {
    const file = req.file;
    if (!file) return next(bad('Выберите фотографию', 'VALIDATION'));
    try {
      const dutyId = int(req.body.dutyId, 'Дежурство', { min: 1 });
      const duty = q.get('SELECT * FROM duties WHERE id = ?', dutyId);
      if (!duty) throw notFound('Дежурство не найдено');
      if (!canManageDuty(req.user, duty)) {
        throw forbidden('Прикрепить фото может ответственный этой команды, куратор или староста');
      }
      const ext = verifyImage(file.path);
      if (!ext) {
        removeDutyPhoto(file.filename);
        throw bad('Файл не является корректным изображением', 'BAD_FILE');
      }
      const count = q.get('SELECT COUNT(*) AS c FROM photos WHERE duty_id = ?', dutyId).c;
      if (count >= 20) {
        removeDutyPhoto(file.filename);
        throw new HttpError(400, 'К одному дежурству можно прикрепить не больше 20 фотографий', 'LIMIT');
      }
      const ts = new Date().toISOString();
      const r = q.run(
        `INSERT INTO photos (duty_id, filename, original_name, mime, size, uploaded_by, team_id, date,
                             check_status, review_note, created_at)
         VALUES (?,?,?,?,?,?,?,?,'pending','',?)`,
        dutyId, file.filename, String(req.body.originalName ?? file.originalname).slice(0, 160),
        file.mimetype, file.size, req.user.id, duty.team_id, duty.date, ts,
      );
      const id = Number(r.lastInsertRowid);
      // Дежурство с фото отправляется на проверку
      if (duty.status === 'planned') {
        q.run("UPDATE duties SET status = 'pending', updated_at = ? WHERE id = ?", ts, dutyId);
      }
      audit(req.user.id, 'photo.upload', 'photo', id, { dutyId, size: file.size }, clientIp(req));
      const p = q.get(
        `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.username AS up_username
         FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by WHERE p.id = ?`, id,
      );
      return res.status(201).json({
        photo: {
          id: p.id, dutyId: p.duty_id, url: `/api/files/photo/${p.id}`,
          originalName: p.original_name, mime: p.mime, size: p.size, date: p.date,
          checkStatus: p.check_status, reviewNote: p.review_note,
          uploadedBy: { id: p.uploaded_by, fullName: `${p.up_last ?? ''} ${p.up_first ?? ''}`.trim(), username: p.up_username },
          createdAt: p.created_at,
        },
      });
    } catch (err) {
      if (file) removeDutyPhoto(file.filename);
      return next(err);
    }
  },
);

/* ─────────── GET /api/photos — галерея (по правам) ─────────── */
router.get('/', requirePermission('photo.view.team'), (req, res, next) => {
  try {
    const scope = str(req.query.scope ?? 'all', 'Фильтр', { required: false, max: 20 });
    const check = req.query.check ? inOneOf(req.query.check, 'Проверка', CHECK_STATUSES) : null;
    const teamId = req.query.teamId ? int(req.query.teamId, 'Команда', { min: 1 }) : null;
    const from = req.query.from ? dateStr(req.query.from, 'Дата «с»') : null;
    const to = req.query.to ? dateStr(req.query.to, 'Дата «до»') : null;

    let rows = q.all(
      `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.middle_name AS up_middle,
              u.username AS up_username, u.avatar AS up_avatar,
              t.name AS team_name, t.number AS team_number, t.color AS team_color
       FROM photos p
       LEFT JOIN users u ON u.id = p.uploaded_by
       LEFT JOIN teams t ON t.id = p.team_id
       ORDER BY p.date DESC, p.created_at DESC LIMIT 300`,
    ).filter((p) => canViewPhoto(req.user, p));

    if (scope === 'pending') rows = rows.filter((p) => p.check_status === 'pending');
    if (scope === 'mine') rows = rows.filter((p) => p.uploaded_by === req.user.id);
    if (scope === 'mineTeam') {
      const t = req.user.team_id ?? q.get('SELECT id FROM teams WHERE responsible_id = ?', req.user.id)?.id;
      rows = rows.filter((p) => p.team_id === t);
    }
    if (check) rows = rows.filter((p) => p.check_status === check);
    if (teamId) rows = rows.filter((p) => p.team_id === teamId);
    if (from) rows = rows.filter((p) => p.date >= from);
    if (to) rows = rows.filter((p) => p.date <= to);

    const all = rows;
    res.json({
      photos: all.map((p) => ({
        id: p.id,
        dutyId: p.duty_id,
        url: `/api/files/photo/${p.id}`,
        originalName: p.original_name,
        mime: p.mime, size: p.size, date: p.date,
        dateLabel: p.date,
        checkStatus: p.check_status, reviewNote: p.review_note,
        team: p.team_id ? { id: p.team_id, number: p.team_number, name: p.team_name, color: p.team_color } : null,
        uploadedBy: p.uploaded_by
          ? {
            id: p.uploaded_by,
            fullName: `${p.up_last ?? ''} ${p.up_first ?? ''}`.trim(),
            username: p.up_username,
            avatar: p.up_avatar ? `/api/files/avatar/${p.uploaded_by}` : null,
          }
          : null,
        canReview: isManager(req.user),
        createdAt: p.created_at,
      })),
      stats: {
        total: all.length,
        pending: all.filter((p) => p.check_status === 'pending').length,
        approved: all.filter((p) => p.check_status === 'approved').length,
        rejected: all.filter((p) => p.check_status === 'rejected').length,
      },
      canReview: isManager(req.user),
    });
  } catch (err) { next(err); }
});

/* ─────────── POST /api/photos/:id/review — подтвердить/отклонить ─────────── */
router.post('/:id(\\d+)/review', requirePermission('photo.review'), (req, res, next) => {
  const id = int(req.params.id, 'Фотография', { min: 1 });
  const photo = q.get('SELECT * FROM photos WHERE id = ?', id);
  if (!photo) return next(notFound('Фотография не найдена'));
  try {
    const status = inOneOf(req.body.status, 'Статус проверки', ['approved', 'rejected', 'pending']);
    const note = str(req.body.note ?? '', 'Комментарий', { required: false, max: 500 });
    const ts = new Date().toISOString();
    q.run(
      'UPDATE photos SET check_status = ?, review_note = ?, checked_by = ?, checked_at = ? WHERE id = ?',
      status, note, req.user.id, ts, id,
    );
    // Если все фото дежурства проверены и нет отклонённых — дежурство «выполнено»
    if (photo.duty_id) {
      const stats = q.get(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN check_status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN check_status = 'rejected' THEN 1 ELSE 0 END) AS rejected
         FROM photos WHERE duty_id = ?`, photo.duty_id,
      );
      if (stats.total > 0 && stats.pending === 0) {
        const duty = q.get('SELECT status FROM duties WHERE id = ?', photo.duty_id);
        if (duty && duty.status !== 'missed') {
          q.run(
            'UPDATE duties SET status = ?, updated_at = ? WHERE id = ?',
            stats.rejected > 0 ? 'missed' : 'done', ts, photo.duty_id,
          );
        }
      }
    }
    audit(req.user.id, 'photo.review', 'photo', id, { status }, clientIp(req));
    const p = q.get(
      `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last, u.username AS up_username,
              t.name AS team_name, t.number AS team_number, t.color AS team_color
       FROM photos p LEFT JOIN users u ON u.id = p.uploaded_by
       LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = ?`, id,
    );
    return res.json({
      photo: {
        id: p.id, dutyId: p.duty_id, url: `/api/files/photo/${p.id}`,
        originalName: p.original_name, date: p.date,
        checkStatus: p.check_status, reviewNote: p.review_note,
        team: p.team_id ? { id: p.team_id, number: p.team_number, name: p.team_name, color: p.team_color } : null,
        uploadedBy: p.uploaded_by ? { id: p.uploaded_by, fullName: `${p.up_last ?? ''} ${p.up_first ?? ''}`.trim() } : null,
      },
      dutyStatus: photo.duty_id ? q.get('SELECT status FROM duties WHERE id = ?', photo.duty_id)?.status ?? null : null,
    });
  } catch (err) { return next(err); }
});

/* ─────────── DELETE /api/photos/:id ─────────── */
router.delete('/:id(\\d+)', requirePermission('photo.view.team'), (req, res, next) => {
  const id = int(req.params.id, 'Фотография', { min: 1 });
  const photo = q.get('SELECT * FROM photos WHERE id = ?', id);
  if (!photo) return next(notFound('Фотография не найдена'));
  const own = photo.uploaded_by === req.user.id;
  if (!own && !isManager(req.user)) return next(forbidden('Можно удалять только свои фотографии'));
  q.run('DELETE FROM photos WHERE id = ?', id);
  removeDutyPhoto(photo.filename);
  audit(req.user.id, 'photo.delete', 'photo', id, {}, clientIp(req));
  return res.json({ ok: true });
});

export default router;
