# aivorah-school-admin-service

School admin backend: students, teachers, parents, grades and sections, classes, import history, workspace settings, dashboard and access requests. Also serves announcements, shared resources and class portfolio for all personas.

**Called by:** frontend School Admin persona, plus announcements, resources and class portfolio screens for teachers, students and parents.

## Endpoints
| Route | What it does |
|---|---|
| `/school-admin/students` | List/filter, create, edit, status, delete, bulk status/grade, bulk import, CSV/XLSX templates |
| `/school-admin/teachers` | List, create, bulk import, templates |
| `/school-admin/parents` | List, create, link children |
| `/school-admin/grades-sections, /grades` | Grades and sections, archive |
| `/school-admin/classes` | Classes and class teacher |
| `/school-admin/overview, /access-requests` | Dashboard numbers, approve/reject access requests |
| `/school-admin/people, /import-history, /workspace-settings` | People search, import log, settings |
| `/announcements` | Admin create / AI draft / publish / archive; users read, mark seen, dismiss |
| `/resources` | Shared folders and files |
| `/class-portfolio` | Class posts, likes, comments, folders, uploads |
| `GET /health` | Health check |

## Run locally
```bash
npm ci
# create .env with the variables in the table below
npm run dev            # nodemon, port 3018
```

## Environment variables
| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3018`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | Supabase project and service-role key (server-only, never expose) |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | File/image uploads |
| `RESEND_API_KEY` / `EMAIL_USER`, `EMAIL_PASS` | Outgoing email: Resend, or Gmail SMTP as fallback |
| `ADMIN_EMAILS`, `ADMIN_EMAIL` | Platform admins allowed into any school |
| `AUTH_ENFORCE` | `enforce` = require a valid Firebase token on `/school-admin`. Anything else = log only |
| `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID` | Firebase token verification and account creation |
| `GROQ_API_KEY` | AI draft for announcements |
| `SMOKE_ADMIN_EMAIL`, `SCHOOL_ADMIN_URL`, `AUTH_URL` | Only for the smoke tests in `tests/smoke` |

## Tests
```bash
npm test
```

## Deploy
- **Render** web service `aivorah-school-admin-service` → https://aivorah-school-admin-service-w0xk.onrender.com
- Auto-deploys from `master`. Build `npm install`, start `npm start`.
- CI: no CI config yet; run `npm test` before merging
- After a merge, check the live commit on Render matches the branch head.

## Auth
`requireAdminScope` limits each admin to their own school. Token checking is only enforced when `AUTH_ENFORCE=enforce`; turn it on before real users.

## Folder layout
| Path | Why it exists |
|---|---|
| `index.js` | Express app: middleware, route mounting, `/health`, listen |
| `routes/` | One file per area (students, teachers, parents, grades, classes, dashboard, announcements, resources, class portfolio, ...) |
| `services/` | Admin scope (which admin manages which school), account provisioning, curriculum, notifications, mailer, Firebase/Supabase clients |
| `tests/` | `unit/`, `integration/`, `smoke/` (smoke hits the live service) |

Note: `aivorah-parental-controls-service` also defaults to port 3018. Set `PORT` on one of them to run both locally.
