/**
 * Сводная статистика для панелей: староста, куратор, ответственный.
 * Каждый блок отдаётся только при наличии соответствующего permission.
 */
import express from 'express';
import { q, getSetting } from '../db.js';
import { requireAuth } from '../middleware.js';
import { publicUser, dutyPublic, DUTY_SELECT, todayStr, addDays, startOfWeek, plural, MARK_META } from '../util.js';
import { isManager, can, leadsTeam, canViewMessage, ROLES } from '../permissions.js';

const router = express.Router();
router.use(requireAuth);

router.get('/overview', (req, res) => {
  const u = req.user;
  const today = todayStr();
  const weekStart = startOfWeek(today);
  const monthStart = `${today.slice(0, 7)}-01`;

  const out = {
    classInfo: { name: getSetting('class_name', '5 «Г»'), school: getSetting('school_name', '') },
    today,
    role: u.role,
    counters: {},
    todayDuties: [],
    myTeam: null,
    stats: {},
  };

  // Карточки-счётчики, доступные по правам
  if (can(u, 'stats.view.all')) {
    out.counters = {
      students: q.get("SELECT COUNT(*) AS c FROM users WHERE role IN ('member','responsible')").c,
      responsibles: q.get('SELECT COUNT(*) AS c FROM teams WHERE responsible_id IS NOT NULL').c,
      teams: q.get('SELECT COUNT(*) AS c FROM teams').c,
      dutiesToday: q.get('SELECT COUNT(*) AS c FROM duties WHERE date = ?', today).c,
      doneToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status = 'done'", today).c,
      pendingToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status = 'pending'", today).c,
      missedTotal: q.get("SELECT COUNT(*) AS c FROM duties WHERE status = 'missed'").c,
      pendingPhotos: q.get("SELECT COUNT(*) AS c FROM photos WHERE check_status = 'pending'").c,
      activeToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status IN ('done','pending')", today).c,
      blocked: q.get('SELECT COUNT(*) AS c FROM users WHERE is_active = 0').c,
    };
  } else {
    out.counters = {
      dutiesToday: q.get('SELECT COUNT(*) AS c FROM duties WHERE date = ?', today).c,
      doneToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status = 'done'", today).c,
      pendingToday: q.get("SELECT COUNT(*) AS c FROM duties WHERE date = ? AND status = 'pending'", today).c,
      teammates: u.team_id ? q.get('SELECT COUNT(*) AS c FROM users WHERE team_id = ?', u.team_id).c : 0,
    };
  }

  out.todayDuties = q.all(`${DUTY_SELECT} WHERE d.date = ? ORDER BY t.number`, today).map((d) => dutyPublic(d));

  if (can(u, 'stats.view.all')) {
    out.weekDuties = q.all(`${DUTY_SELECT} WHERE d.date BETWEEN ? AND ? ORDER BY d.date`, weekStart, addDays(weekStart, 6)).map(dutyPublic);
    out.monthStats = {
      total: q.get('SELECT COUNT(*) AS c FROM duties WHERE date >= ? AND date <= ?', monthStart, today).c,
      done: q.get("SELECT COUNT(*) AS c FROM duties WHERE date >= ? AND date <= ? AND status = 'done'", monthStart, today).c,
      missed: q.get("SELECT COUNT(*) AS c FROM duties WHERE date >= ? AND date <= ? AND status = 'missed'", monthStart, today).c,
      pending: q.get("SELECT COUNT(*) AS c FROM duties WHERE date >= ? AND date <= ? AND status = 'pending'", monthStart, today).c,
    };
    out.teamStats = q.all(
      `SELECT t.*, (SELECT COUNT(*) FROM duties d WHERE d.team_id = t.id AND d.status = 'done') AS done,
              (SELECT COUNT(*) FROM duties d WHERE d.team_id = t.id) AS total
       FROM teams t ORDER BY t.number`,
    ).map((t) => ({
      id: t.id, number: t.number, name: t.name, color: t.color,
      done: t.done, total: t.total, rate: t.total ? Math.round((t.done / t.total) * 100) : 0,
      responsible: t.responsible_id ? publicUser(q.get('SELECT * FROM users WHERE id = ?', t.responsible_id)) : null,
    }));
    out.topAbsences = q.all(
      `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color,
              (SELECT COUNT(*) FROM duty_marks dm JOIN duties d ON d.id = dm.duty_id
                WHERE dm.user_id = u.id AND dm.mark = 'absent') AS absences
       FROM users u LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.role IN ('member','responsible')
       ORDER BY absences DESC, u.last_name LIMIT 6`,
    ).map((u) => ({ ...publicUser(u), absences: u.absences }));
    out.recentPhotos = q.all(
      `SELECT p.*, u.first_name AS up_first, u.last_name AS up_last FROM photos p
       LEFT JOIN users u ON u.id = p.uploaded_by ORDER BY p.created_at DESC LIMIT 6`,
    ).map((p) => ({
      id: p.id, url: `/api/files/photo/${p.id}`, date: p.date, checkStatus: p.check_status,
      uploadedBy: `${p.up_last ?? ''} ${p.up_first ?? ''}`.trim(),
    }));
  }

  // Личный блок ответственного
  const teamId = u.team_id ?? q.get('SELECT id FROM teams WHERE responsible_id = ?', u.id)?.id ?? null;
  if (teamId) {
    const team = q.get('SELECT * FROM teams WHERE id = ?', teamId);
    const isResponsible = team.responsible_id === u.id;
    const members = q.all(
      `SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
       FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.team_id = ? ORDER BY u.last_name, u.first_name`,
      teamId,
    );
    const todayDuty = q.get(`${DUTY_SELECT} WHERE d.team_id = ? AND d.date = ?`, teamId, today);
    const marks = new Map(
      todayDuty ? q.all('SELECT * FROM duty_marks WHERE duty_id = ?', todayDuty.id).map((m) => [m.user_id, m]) : [],
    );
    out.myTeam = {
      id: team.id, number: team.number, name: team.name, color: team.color,
      isResponsible,
      responsible: team.responsible_id
        ? publicUser(q.get(`SELECT u.*, t.name AS team_name, t.number AS team_number, t.color AS team_color
                            FROM users u LEFT JOIN teams t ON t.id = u.team_id WHERE u.id = ?`, team.responsible_id))
        : null,
      members: members.map((m) => {
        const mk = marks.get(m.id);
        return { ...publicUser(m), mark: mk?.mark ?? 'unmarked', markLabel: MARK_META[mk?.mark ?? 'unmarked'].label, markTone: MARK_META[mk?.mark ?? 'unmarked'].tone };
      }),
      todayDuty: todayDuty ? { ...dutyPublic(todayDuty), canManage: isResponsible || isManager(u) } : null,
      nextDuty: q.get(`${DUTY_SELECT} WHERE d.team_id = ? AND d.date > ? ORDER BY d.date LIMIT 1`, teamId, today),
      stats: {
        total: q.get('SELECT COUNT(*) AS c FROM duties WHERE team_id = ?', teamId).c,
        done: q.get("SELECT COUNT(*) AS c FROM duties WHERE team_id = ? AND status = 'done'", teamId).c,
        missed: q.get("SELECT COUNT(*) AS c FROM duties WHERE team_id = ? AND status = 'missed'", teamId).c,
      },
    };
    if (out.myTeam.nextDuty) out.myTeam.nextDuty = dutyPublic(out.myTeam.nextDuty);
  }

  // История дежурств самого пользователя
  const myMarks = q.all('SELECT duty_id, mark FROM duty_marks WHERE user_id = ?', u.id);
  out.myStats = {
    total: myMarks.length,
    served: myMarks.filter((m) => m.mark === 'served').length,
    absent: myMarks.filter((m) => m.mark === 'absent').length,
    notServed: myMarks.filter((m) => m.mark === 'not_served').length,
    unmarked: myMarks.filter((m) => m.mark === 'unmarked').length,
  };
  out.myDuties = q.all(
    `${DUTY_SELECT} JOIN duty_marks dm ON dm.duty_id = d.id WHERE dm.user_id = ? ORDER BY d.date DESC LIMIT 8`,
    u.id,
  ).map((d) => {
    const m = q.get('SELECT mark FROM duty_marks WHERE duty_id = ? AND user_id = ?', d.id, u.id);
    return { ...dutyPublic(d), myMark: m?.mark ?? 'unmarked', markLabel: MARK_META[m?.mark ?? 'unmarked'].label, markTone: MARK_META[m?.mark ?? 'unmarked'].tone };
  });

  // Ближайшее дежурство
  const nextLead = q.get(`${DUTY_SELECT} WHERE d.responsible_id = ? AND d.date >= ? ORDER BY d.date LIMIT 1`, u.id, today);
  const nextTeam = teamId ? q.get(`${DUTY_SELECT} WHERE d.team_id = ? AND d.date >= ? ORDER BY d.date LIMIT 1`, teamId, today) : null;
  out.nextDuty = (nextLead && nextTeam)
    ? (nextLead.date <= nextTeam.date ? dutyPublic(nextLead) : dutyPublic(nextTeam))
    : dutyPublic(nextLead ?? nextTeam);

  // Непрочитанные: видимые адресату и без отметки о прочтении.
  // Логика повторяет GET /api/messages, чтобы бейдж и лента не расходились.
  out.unread = q.all(
    'SELECT id, audience, team_id, target_user_id, author_id FROM messages ORDER BY created_at DESC LIMIT 200',
  ).filter((m) => canViewMessage(req.user, m))
    .filter((m) => !q.get('SELECT 1 AS x FROM message_reads WHERE message_id = ? AND user_id = ?', m.id, req.user.id))
    .length;
  out.notices = q.all(
    `SELECT m.id, m.title, m.created_at FROM messages m
     WHERE m.kind = 'notice' AND (m.audience = 'class' OR m.audience = 'team' AND m.team_id = ? OR m.audience = 'user' AND m.target_user_id = ?)
     ORDER BY m.created_at DESC LIMIT 3`, teamId, u.id,
  );

  res.json(out);
});

export default router;
