# Configuration and setup

This project stores runtime configuration outside source control. The backend reads from `server/.env` and the frontend reads Vite environment variables from the client-side env file.

## 1. Required software

- Node.js 20 LTS or newer recommended
- npm 10+
- MySQL 8.0.16 or newer (or a compatible MySQL server)
- a local empty database for development setup

## 2. Environment variables

### Backend (`server/.env`)

```dotenv
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_db_user
DB_PASSWORD=your_local_password
DB_NAME=bank_management_system
SESSION_SECRET=replace-with-a-random-32-character-secret
PORT=5000
NODE_ENV=development
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAME_SITE=lax
LOGIN_RATE_LIMIT=20
```

### Frontend (`client/.env` or `client/.env.development`)

```dotenv
VITE_API_BASE=/api
```

The repo contains sanitized templates:

- `server/.env.example.template`
- `client/.env.example.template`

These templates are tracked; the real `.env` files remain local-only and ignored by Git.

## 3. Local setup procedure

1. Clone the repository.
2. Install backend dependencies:

```sh
cd server
npm install
```

3. Install frontend dependencies:

```sh
cd ../client
npm install
```

4. Create a local database in MySQL.

```sql
CREATE DATABASE bank_management_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

5. Copy the template files and change values for the local environment only.

```sh
cp server/.env.example.template server/.env
cp client/.env.example.template client/.env
```

6. Run the database migration:

```sh
cd server
npm run migrate
```

## 4. Application startup

Backend:

```sh
cd server
npm run dev
```

Frontend:

```sh
cd client
npm run dev
```

Expected defaults:

- backend: `http://localhost:5000`
- frontend: `http://localhost:5173`
- API calls are routed to the backend via the Vite proxy

Verify the API is responding:

```sh
curl http://localhost:5000/api/health
```

## 5. Common setup failures and fixes

### Missing environment variables

The startup code validates required configuration values and exits early if required values are missing or malformed. Confirm that the local `.env` files exist and contain the required keys.

### Invalid database credentials

Verify that `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` match the actual MySQL instance and database created for this project.

### Database server unavailable

Confirm that the MySQL service is running and reachable at the configured host and port.

### Missing dependencies

Run `npm install` in both the `server` and `client` directories.

### Port already in use

Update `PORT` in `server/.env` or stop the process already using the port.

### Migration failure

Use the migration output to identify the failing data or schema issue. Do not overwrite an existing database without a verified backup.

### Frontend/backend connection problems

Confirm `VITE_API_BASE` is set correctly or leave it at `/api` for the local Vite proxy.

## 6. Operational scripts

Available scripts in `server/package.json`:

```sh
npm run migrate
npm run migrate:status
npm run initialize-admin
npm run reset-admin-password
npm run backup:db
npm run restore:db
npm test
```

Available frontend scripts in `client/package.json`:

```sh
npm run dev
npm run build
npm run lint
```

## 7. Security and hygiene

- never commit `.env` files
- never commit database dumps or backup archives
- never expose credential values in logs or documentation
- use `.gitignore` rules to keep environment files local-only
- keep `server/.env.example` untouched; use the tracked `.env.example.template` files instead
