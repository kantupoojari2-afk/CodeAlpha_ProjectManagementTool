# TaskFlow - Project Management Tool

A collaborative project management tool (similar to Trello / Asana) built for the
CodeAlpha Full Stack Development internship, **Task 3**.

## Features

- **User authentication**: register and log in with hashed passwords (bcrypt) and JWT sessions.
- **Projects**: create projects, see the ones you belong to, and add teammates by email.
- **Project boards**: Kanban-style board with *To Do*, *In Progress* and *Done* columns.
- **Task cards**: create, edit and delete cards with title, description, priority, status and assignee.
  Drag and drop cards between columns to update their status.
- **Comments**: discuss each task inside its card.
- **Bonus - Notifications and real-time updates**: Socket.IO pushes live updates to every member
  of a project (new/moved/edited cards, new comments, new members) and sends notifications when
  you are assigned a task, commented on your task or added to a project.

## Tech stack

| Layer    | Technology                                   |
|----------|----------------------------------------------|
| Frontend | HTML, CSS, vanilla JavaScript                |
| Backend  | Node.js, Express.js                          |
| Database | SQLite (better-sqlite3)                      |
| Auth     | JSON Web Tokens (jsonwebtoken), bcryptjs     |
| Realtime | Socket.IO                                    |

## Project structure

```
CodeAlpha_ProjectManagementTool/
├── server.js        # Express app, REST API, Socket.IO server
├── db.js            # SQLite connection and schema
├── package.json
├── public/
│   ├── index.html   # Single page UI
│   ├── style.css    # Styling
│   └── app.js       # Front-end logic (API calls, board, drag & drop, sockets)
└── README.md
```

## Database schema

- `users` - id, name, email (unique), password (hashed), created_at
- `projects` - id, name, description, owner_id, created_at
- `project_members` - project_id, user_id, role (`owner` / `member`)
- `tasks` - id, project_id, title, description, status, priority, assignee_id, created_by, position
- `comments` - id, task_id, user_id, body, created_at
- `notifications` - id, user_id, message, link_project_id, is_read, created_at

## Getting started

Requirements: Node.js 18 or newer.

```bash
cd CodeAlpha_ProjectManagementTool
npm install
npm start
```

Open http://localhost:3000 in your browser. To test collaboration, open a second
browser window (or private window), register another user, and add them to your
project using their email.

Optional: set a real secret for JWT signing:

```bash
JWT_SECRET=my-long-random-secret npm start
```

## REST API

| Method | Endpoint                          | Description                          |
|--------|-----------------------------------|--------------------------------------|
| POST   | /api/auth/register                | Create an account                    |
| POST   | /api/auth/login                   | Log in, returns a JWT                |
| GET    | /api/auth/me                      | Current user                         |
| GET    | /api/projects                     | Projects the user belongs to         |
| POST   | /api/projects                     | Create a project                     |
| GET    | /api/projects/:id                 | Project with members and tasks       |
| DELETE | /api/projects/:id                 | Delete a project (owner only)        |
| POST   | /api/projects/:id/members         | Add a member by email (owner only)   |
| POST   | /api/projects/:id/tasks           | Create a task card                   |
| PATCH  | /api/tasks/:id                    | Update a task (status, assignee...)  |
| DELETE | /api/tasks/:id                    | Delete a task                        |
| GET    | /api/tasks/:id/comments           | List comments on a task              |
| POST   | /api/tasks/:id/comments           | Add a comment                        |
| GET    | /api/notifications                | Latest notifications and unread count|
| POST   | /api/notifications/read-all       | Mark all notifications as read       |

## Socket.IO events

Clients join `project:<id>` rooms and `user:<id>` rooms automatically.

| Event               | Sent to              | Payload                       |
|---------------------|----------------------|-------------------------------|
| `task:created`      | project room         | task                          |
| `task:updated`      | project room         | task                          |
| `task:deleted`      | project room         | `{ id, project_id }`          |
| `comment:created`   | project room         | comment with `project_id`     |
| `member:added`      | project room         | `{ project_id, user_id }`     |
| `notification`      | single user          | notification                  |
