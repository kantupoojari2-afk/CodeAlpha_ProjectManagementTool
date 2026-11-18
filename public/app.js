/* TaskFlow front end - vanilla JS talking to the Express API and Socket.IO */

const state = {
  token: localStorage.getItem('tf_token'),
  user: null,
  socket: null,
  mode: 'login',           // login | register
  currentProject: null,    // project id on the board
  projectData: null,       // { project, role, members, tasks }
  editingTaskId: null,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (sqlDate) => {
  const d = new Date(sqlDate.includes('T') ? sqlDate : sqlDate.replace(' ', 'T') + 'Z');
  return isNaN(d) ? '' : d.toLocaleString();
};

/* ---------- API helper ---------- */

async function api(url, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 3500);
}

function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

/* ---------- Screens ---------- */

function showAuth() {
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  showProjects();
}

function showProjects() {
  if (state.socket && state.currentProject) state.socket.emit('project:leave', state.currentProject);
  state.currentProject = null;
  $('#board-view').classList.add('hidden');
  $('#projects-view').classList.remove('hidden');
  loadProjects();
}

/* ---------- Auth ---------- */

function setAuthMode(mode) {
  state.mode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#name').classList.toggle('hidden', mode === 'login');
  $('#name').required = mode === 'register';
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  $('#auth-error').textContent = '';
}

$('#tab-login').onclick = () => setAuthMode('login');
$('#tab-register').onclick = () => setAuthMode('register');

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { email: $('#email').value, password: $('#password').value };
  if (state.mode === 'register') body.name = $('#name').value;
  try {
    const path = state.mode === 'login' ? '/api/auth/login' : '/api/auth/register';
    const data = await api(path, { method: 'POST', body });
    startSession(data.token, data.user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

function startSession(token, user) {
  state.token = token;
  state.user = user;
  localStorage.setItem('tf_token', token);
  $('#me-name').textContent = user.name;
  connectSocket();
  showApp();
  loadNotifications();
}

$('#logout').onclick = () => {
  localStorage.removeItem('tf_token');
  if (state.socket) state.socket.disconnect();
  location.reload();
};

/* ---------- Projects ---------- */

async function loadProjects() {
  const projects = await api('/api/projects');
  $('#project-list').innerHTML = projects.map((p) => `
    <div class="project-card" data-id="${p.id}">
      <h3>${esc(p.name)}</h3>
      <p class="muted">${esc(p.description || 'No description')}</p>
      <div class="small muted">${p.task_count} task(s) · ${esc(p.role)}</div>
    </div>`).join('') || '<p class="muted">No projects yet. Create one to get started.</p>';
}

$('#project-list').addEventListener('click', (e) => {
  const card = e.target.closest('.project-card');
  if (card) openProject(Number(card.dataset.id));
});

$('#new-project-btn').onclick = () => {
  $('#project-form').reset();
  $('#project-error').textContent = '';
  $('#project-modal').classList.remove('hidden');
};

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  try {
    const { id } = await api('/api/projects', {
      method: 'POST',
      body: { name: f.name.value, description: f.description.value },
    });
    closeModals();
    openProject(id);
  } catch (err) {
    $('#project-error').textContent = err.message;
  }
});

/* ---------- Board ---------- */

async function openProject(id) {
  if (state.socket) state.socket.emit('project:join', id);
  state.currentProject = id;
  try {
    await loadBoard();
    $('#projects-view').classList.add('hidden');
    $('#board-view').classList.remove('hidden');
  } catch (err) {
    toast(err.message);
    showProjects();
  }
}

async function loadBoard() {
  state.projectData = await api(`/api/projects/${state.currentProject}`);
  renderBoard();
}

function cardHTML(t) {
  return `
    <div class="card" draggable="true" data-id="${t.id}">
      <div class="card-top">
        <span class="prio prio-${esc(t.priority)}">${esc(t.priority)}</span>
        <span class="small muted">💬 ${t.comment_count}</span>
      </div>
      <div class="card-title">${esc(t.title)}</div>
      <div class="card-foot small muted">
        <span>${t.assignee_name ? '👤 ' + esc(t.assignee_name) : 'Unassigned'}</span>
      </div>
    </div>`;
}

function renderBoard() {
  const { project, role, members, tasks } = state.projectData;
  $('#board-title').textContent = project.name;
  $('#board-desc').textContent = project.description || '';
  $('#board-members').textContent = 'Members: ' + members.map((m) => m.name).join(', ');
  $('#add-member-btn').classList.toggle('hidden', role !== 'owner');

  document.querySelectorAll('.column').forEach((col) => {
    const list = tasks.filter((t) => t.status === col.dataset.status);
    col.querySelector('.count').textContent = list.length;
    col.querySelector('.cards').innerHTML = list.map(cardHTML).join('') || '<p class="empty">No tasks</p>';
  });
}

$('#back-btn').onclick = () => showProjects();
$('#new-task-btn').onclick = () => openTaskModal(null, 'todo');

// Click a card to edit it
$('.board').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openTaskModal(Number(card.dataset.id));
});

// Drag and drop cards between columns
const board = $('.board');
board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (card) {
    e.dataTransfer.setData('text/plain', card.dataset.id);
    card.style.opacity = '0.5';
  }
});
board.addEventListener('dragend', (e) => {
  const card = e.target.closest('.card');
  if (card) card.style.opacity = '';
});
board.addEventListener('dragover', (e) => {
  const col = e.target.closest('.column');
  if (col) {
    e.preventDefault();
    document.querySelectorAll('.column').forEach((c) => c.classList.toggle('drag-over', c === col));
  }
});
board.addEventListener('dragleave', (e) => {
  const col = e.target.closest('.column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
});
board.addEventListener('drop', async (e) => {
  const col = e.target.closest('.column');
  if (!col) return;
  e.preventDefault();
  document.querySelectorAll('.column').forEach((c) => c.classList.remove('drag-over'));
  const taskId = e.dataTransfer.getData('text/plain');
  const task = state.projectData.tasks.find((t) => String(t.id) === taskId);
  if (!task || task.status === col.dataset.status) return;
  try {
    await api(`/api/tasks/${taskId}`, { method: 'PATCH', body: { status: col.dataset.status } });
    await loadBoard();
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Task modal ---------- */

function openTaskModal(taskId = null, defaultStatus = 'todo') {
  const form = $('#task-form');
  const f = form.elements;
  form.reset();
  state.editingTaskId = taskId;

  const { members, tasks } = state.projectData;
  f.assignee_id.innerHTML =
    '<option value="">Unassigned</option>' +
    members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');

  const task = taskId ? tasks.find((t) => t.id === taskId) : null;
  $('#task-modal-title').textContent = task ? 'Edit task' : 'New task';
  $('#task-delete').classList.toggle('hidden', !task);
  $('#comments-section').classList.toggle('hidden', !task);

  if (task) {
    f.title.value = task.title;
    f.description.value = task.description || '';
    f.status.value = task.status;
    f.priority.value = task.priority;
    f.assignee_id.value = task.assignee_id || '';
    loadComments(task.id);
  } else {
    f.status.value = defaultStatus;
  }

  $('#task-error').textContent = '';
  $('#task-modal').classList.remove('hidden');
}

$('#task-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    title: f.title.value,
    description: f.description.value,
    status: f.status.value,
    priority: f.priority.value,
    assignee_id: f.assignee_id.value || null,
  };
  try {
    if (state.editingTaskId) {
      await api(`/api/tasks/${state.editingTaskId}`, { method: 'PATCH', body });
    } else {
      await api(`/api/projects/${state.currentProject}/tasks`, { method: 'POST', body });
    }
    closeModals();
    await loadBoard();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
});

$('#task-delete').onclick = async () => {
  if (!confirm('Delete this task and its comments?')) return;
  try {
    await api(`/api/tasks/${state.editingTaskId}`, { method: 'DELETE' });
    closeModals();
    await loadBoard();
  } catch (err) {
    $('#task-error').textContent = err.message;
  }
};

/* ---------- Comments ---------- */

function commentHTML(c) {
  return `
    <li>
      <strong>${esc(c.user_name)}</strong>
      <span class="small muted">${fmtDate(c.created_at)}</span>
      <div>${esc(c.body)}</div>
    </li>`;
}

async function loadComments(taskId) {
  const comments = await api(`/api/tasks/${taskId}/comments`);
  $('#comment-list').innerHTML =
    comments.map(commentHTML).join('') || '<li class="muted">No comments yet</li>';
}

$('#comment-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = e.target.elements.body;
  try {
    await api(`/api/tasks/${state.editingTaskId}/comments`, {
      method: 'POST',
      body: { body: input.value },
    });
    input.value = '';
    await loadComments(state.editingTaskId);
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Members ---------- */

$('#add-member-btn').onclick = () => {
  $('#member-form').reset();
  $('#member-error').textContent = '';
  $('#member-modal').classList.remove('hidden');
};

$('#member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { member } = await api(`/api/projects/${state.currentProject}/members`, {
      method: 'POST',
      body: { email: e.target.elements.email.value },
    });
    closeModals();
    toast(`${member.name} added to the project`);
    await loadBoard();
  } catch (err) {
    $('#member-error').textContent = err.message;
  }
});

/* ---------- Notifications ---------- */

async function loadNotifications() {
  try {
    const { items, unread } = await api('/api/notifications');
    $('#notif-list').innerHTML = items.map((n) => `
      <li class="${n.is_read ? '' : 'unread'}" data-pid="${n.link_project_id || ''}">
        ${esc(n.message)}
        <div class="small muted">${fmtDate(n.created_at)}</div>
      </li>`).join('') || '<li class="muted">No notifications yet</li>';
    const badge = $('#notif-count');
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
  } catch {
    /* ignore while logged out */
  }
}

$('#bell').onclick = (e) => {
  e.stopPropagation();
  $('#notif-panel').classList.toggle('hidden');
  if (!$('#notif-panel').classList.contains('hidden')) loadNotifications();
};

document.addEventListener('click', (e) => {
  if (!e.target.closest('.bell-wrap')) $('#notif-panel').classList.add('hidden');
});

$('#notif-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-pid]');
  if (!li || !li.dataset.pid) return;
  $('#notif-panel').classList.add('hidden');
  if (!$('#board-view').classList.contains('hidden') && state.currentProject === Number(li.dataset.pid)) return;
  openProject(Number(li.dataset.pid));
});

$('#read-all').onclick = async () => {
  await api('/api/notifications/read-all', { method: 'POST' });
  loadNotifications();
};

/* ---------- Real-time (Socket.IO) ---------- */

function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });
  const s = state.socket;

  // Rejoin the project room after a reconnect
  s.on('connect', () => {
    if (state.currentProject) s.emit('project:join', state.currentProject);
  });
  s.on('connect_error', (err) => console.warn('Realtime connection failed:', err.message));

  const refreshIfViewing = (projectId) => {
    if (state.currentProject === projectId && !$('#board-view').classList.contains('hidden')) {
      loadBoard().catch(() => {});
    }
  };

  s.on('notification', (n) => {
    toast(n.message);
    loadNotifications();
  });
  s.on('task:created', (t) => refreshIfViewing(t.project_id));
  s.on('task:updated', (t) => refreshIfViewing(t.project_id));
  s.on('task:deleted', (t) => refreshIfViewing(t.project_id));
  s.on('comment:created', (c) => {
    refreshIfViewing(c.project_id);
    if (state.editingTaskId === c.task_id) loadComments(c.task_id).catch(() => {});
  });
  s.on('member:added', (m) => {
    refreshIfViewing(m.project_id);
  });
  s.on('project:deleted', (d) => {
    if (state.currentProject === d.project_id) {
      toast('This project was deleted');
      showProjects();
    }
  });
}

/* ---------- Modal close + startup ---------- */

document.querySelectorAll('[data-close]').forEach((btn) => (btn.onclick = closeModals));
document.querySelectorAll('.modal').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) closeModals(); })
);

(async function init() {
  setAuthMode('login');
  if (!state.token) return showAuth();
  try {
    const { user } = await api('/api/auth/me');
    startSession(state.token, user);
  } catch {
    localStorage.removeItem('tf_token');
    state.token = null;
    showAuth();
  }
})();
