# MediStock Pro (PostgreSQL / Neon version)

React (Vite + Tailwind) frontend, Express backend, PostgreSQL database (Neon).

## Database setup (once)
Run `database/schema.sql` on your database: in the Neon dashboard open **SQL Editor**, paste the file, click Run.
(Locally: `psql "<your DATABASE_URL>" -f database/schema.sql`)

## Backend
1. `cd server`, then `copy .env.example .env` (Mac/Linux: `cp`), and fill in `.env`.
2. `npm install`
3. `npm run seed`  (creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD + fictional demo data)
4. `npm start`  -> check http://localhost:5000/api/health shows `{"ok":true}`

## Frontend
1. `cd client`, `npm install`, `npm run dev` -> http://localhost:5173 (calls `/api`, proxied to port 5000)
2. For production (Vercel): set env var `VITE_API_URL` to your deployed backend URL ending in `/api`, then `npm run build`.

## Production notes
- Never commit `.env` (already in .gitignore). Set the same variables in your host's dashboard.
- Set a strong, unique JWT_SECRET. Changing it logs everyone out.
- Add your frontend URL to `CORS_ORIGINS` if it is not on *.vercel.app.
- The login endpoint has no rate limiting yet; add one (e.g. express-rate-limit) before public launch.

## Working (tested on PostgreSQL through the API)
Login/roles, staff create/disable (disabled users lose access immediately), change password, medicines (add/edit/archive/search/barcode), batches + expiry status, stock adjustment, suppliers (add/edit/archive), purchases (transactional), POS sales (server re-checks expiry/stock, discounts owner-only, duplicate-submit protection, rollback), sales search, full-sale return, dashboard, notifications, analytics API, CSV export, settings API.

## Not built yet
Analytics/Settings/Profile pages, medicine-edit and stock-adjust forms, POS discount field, PDF invoice (browser Print only), partial returns, forecasting, assistant, barcode camera. The UI has not been visually reviewed in a browser.
