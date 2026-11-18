const express = require('express');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const STATUSES = ['todo', 'in_progress', 'done'];
const PRIORITIES = ['low', 'medium', 'high'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const signToken = (user) =>
  jwt.sign({ id: user.id, name: user.name }, JWT_SECRET, { expiresIn: '7d' });

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in first' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please log in again' });
  }
}

const roleIn = (projectId, userId) =>
  db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId)?.role || null;

const nextPosition = (projectId, status) =>
  db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks WHERE project_id = ? AND status = ?')
    .get(projectId, status).p;

const getTask = (id) =>
  db.prepare(`
    SELECT t.*, u.name AS assignee_name,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.id = ?`).get(id);

// Stores a notification for a user and pushes it live to that user's socket room.
function notify(userId, message, projectId) {
  const info = db.prepare(
    'INSERT INTO notifications (user_id, message, link_project_id) VALUES (?, ?, ?)'
  ).run(userId, message, projectId);
  io.to(`user:${userId}`).emit('notification', {
    id: info.lastInsertRowid,
    message,
    link_project_id: projectId,
    is_read: 0,
    created_at: new Date().toISOString(),
  });
}

/* ---------- auth ---------- */

app.post('/api/auth/register', async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';

  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const hash = await bcrypt.hash(password, 10);
  const info = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hash);
  const user = { id: info.lastInsertRowid, name, email };
  res.status(201).json({ token: signToken(user), user });
});

app.post('/api/auth/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !(await bcrypt.compare(password, row.password))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  const user = { id: row.id, name: row.name, email: row.email };
  res.json({ token: signToken(user), user });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ user });
});

/* ---------- projects ---------- */

app.get('/api/projects', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, p.description, p.owner_id, pm.role,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count
    FROM projects p
    JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
    ORDER BY p.created_at DESC, p.id DESC`).all(req.user.id);
  res.json(rows);
});

app.post('/api/projects', requireAuth, (req, res) => {
  const name = (req.body.name || '').trim();
  const description = (req.body.description || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  const create = db.transaction(() => {
    const info = db.prepare('INSERT INTO projects (name, description, owner_id) VALUES (?, ?, ?)')
      .run(name, description, req.user.id);
    db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'owner')")
      .run(info.lastInsertRowid, req.user.id);
    return info.lastInsertRowid;
  });
  res.status(201).json({ id: create() });
});

app.get('/api/projects/:id', requireAuth, (req, res) => {
  const pid = Number(req.params.id);
  const role = roleIn(pid, req.user.id);
  if (!role) return res.status(404).json({ error: 'Project not found' });

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(pid);
  const members = db.prepare(`
    SELECT u.id, u.name, u.email, pm.role
    FROM project_members pm JOIN users u ON u.id = pm.user_id
    WHERE pm.project_id = ? ORDER BY u.name`).all(pid);
  const tasks = db.prepare(`
    SELECT t.*, u.name AS assignee_name,
      (SELECT COUNT(*) FROM comments c WHERE c.task_id = t.id) AS comment_count
    FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
    WHERE t.project_id = ?
    ORDER BY t.position, t.id`).all(pid);

  res.json({ project, role, members, tasks });
});

app.delete('/api/projects/:id', requireAuth, (req, res) => {
  const pid = Number(req.params.id);
  if (roleIn(pid, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can delete a project' });
  db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
  io.to(`project:${pid}`).emit('project:deleted', { project_id: pid });
  res.json({ ok: true });
});

app.post('/api/projects/:id/members', requireAuth, (req, res) => {
  const pid = Number(req.params.id);
  if (roleIn(pid, req.user.id) !== 'owner') return res.status(403).json({ error: 'Only the owner can add members' });

  const email = (req.body.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: 'No registered user with that email' });
  if (roleIn(pid, user.id)) return res.status(409).json({ error: 'That user is already a member' });

  db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'member')").run(pid, user.id);
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(pid);
  notify(user.id, `${req.user.name} added you to "${project.name}"`, pid);
  io.to(`project:${pid}`).emit('member:added', { project_id: pid, user_id: user.id });
  res.status(201).json({ ok: true, member: { id: user.id, name: user.name } });
});

/* ---------- tasks (cards) ---------- */

app.post('/api/projects/:id/tasks', requireAuth, (req, res) => {
  const pid = Number(req.params.id);
  if (!roleIn(pid, req.user.id)) return res.status(404).json({ error: 'Project not found' });

  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const status = req.body.status || 'todo';
  const priority = req.body.priority || 'medium';
  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;

  if (!title) return res.status(400).json({ error: 'Task title is required' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (!PRIORITIES.includes(priority)) return res.status(400).json({ error: 'Invalid priority' });
  if (assigneeId && !roleIn(pid, assigneeId)) return res.status(400).json({ error: 'Assignee must be a project member' });

  const info = db.prepare(`
    INSERT INTO tasks (project_id, title, description, status, priority, assignee_id, created_by, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    pid, title, description, status, priority, assigneeId, req.user.id, nextPosition(pid, status)
  );

  const task = getTask(info.lastInsertRowid);
  io.to(`project:${pid}`).emit('task:created', task);
  if (assigneeId && assigneeId !== req.user.id) {
    notify(assigneeId, `${req.user.name} assigned you "${task.title}"`, pid);
  }
  res.status(201).json(task);
});

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task || !roleIn(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });

  const body = req.body;
  const fields = {};

  if ('title' in body) {
    const title = (body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    fields.title = title;
  }
  if ('description' in body) fields.description = (body.description || '').trim();
  if ('priority' in body) {
    if (!PRIORITIES.includes(body.priority)) return res.status(400).json({ error: 'Invalid priority' });
    fields.priority = body.priority;
  }
  if ('status' in body) {
    if (!STATUSES.includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
    fields.status = body.status;
    // Moving to a new column puts the card at the bottom unless a position is given.
    if (body.status !== task.status && !('position' in body)) {
      fields.position = nextPosition(task.project_id, body.status);
    }
  }
  if ('position' in body) fields.position = Number(body.position) || 0;
  if ('assignee_id' in body) {
    const aid = body.assignee_id ? Number(body.assignee_id) : null;
    if (aid && !roleIn(task.project_id, aid)) return res.status(400).json({ error: 'Assignee must be a project member' });
    fields.assignee_id = aid;
  }

  const keys = Object.keys(fields);
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), task.id);
  }

  const updated = getTask(task.id);
  io.to(`project:${task.project_id}`).emit('task:updated', updated);
  if (fields.assignee_id && fields.assignee_id !== task.assignee_id && fields.assignee_id !== req.user.id) {
    notify(fields.assignee_id, `${req.user.name} assigned you "${updated.title}"`, task.project_id);
  }
  res.json(updated);
});

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT id, project_id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task || !roleIn(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });
  db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
  io.to(`project:${task.project_id}`).emit('task:deleted', { id: task.id, project_id: task.project_id });
  res.json({ ok: true });
});

/* ---------- comments ---------- */

app.get('/api/tasks/:id/comments', requireAuth, (req, res) => {
  const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task || !roleIn(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });
  const comments = db.prepare(`
    SELECT c.id, c.task_id, c.body, c.created_at, c.user_id, u.name AS user_name
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.task_id = ? ORDER BY c.created_at, c.id`).all(req.params.id);
  res.json(comments);
});

app.post('/api/tasks/:id/comments', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task || !roleIn(task.project_id, req.user.id)) return res.status(404).json({ error: 'Task not found' });

  const body = (req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Comment cannot be empty' });

  const info = db.prepare('INSERT INTO comments (task_id, user_id, body) VALUES (?, ?, ?)')
    .run(task.id, req.user.id, body);
  const comment = db.prepare(`
    SELECT c.id, c.task_id, c.body, c.created_at, c.user_id, u.name AS user_name
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?`).get(info.lastInsertRowid);

  io.to(`project:${task.project_id}`).emit('comment:created', { ...comment, project_id: task.project_id });

  // Let the assignee and card creator know someone else commented.
  const recipients = new Set([task.assignee_id, task.created_by]);
  recipients.delete(null);
  recipients.delete(undefined);
  recipients.delete(req.user.id);
  for (const uid of recipients) {
    notify(uid, `${req.user.name} commented on "${task.title}"`, task.project_id);
  }
  res.status(201).json(comment);
});

/* ---------- notifications ---------- */

app.get('/api/notifications', requireAuth, (req, res) => {
  const items = db.prepare(
    'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30'
  ).all(req.user.id);
  const { unread } = db.prepare(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND is_read = 0'
  ).get(req.user.id);
  res.json({ items, unread });
});

app.post('/api/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

/* ---------- 404 and error handling ---------- */

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

/* ---------- real-time (Socket.IO) ---------- */

io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.user.id}`);

  // Only members may listen to a project's live updates.
  socket.on('project:join', (projectId) => {
    const pid = Number(projectId);
    if (roleIn(pid, socket.user.id)) socket.join(`project:${pid}`);
  });
  socket.on('project:leave', (projectId) => socket.leave(`project:${Number(projectId)}`));
});

server.listen(PORT, () => {
  console.log(`TaskFlow running at http://localhost:${PORT}`);
});
