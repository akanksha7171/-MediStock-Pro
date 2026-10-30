# MediStock Pro

Pharmacy stock, expiry and billing system. React (Vite + Tailwind) frontend, Express backend, MySQL database.

## Run on Windows (first time)
1. Install **Node.js LTS** (nodejs.org) and **MySQL** (or XAMPP). Remember your MySQL root password.
2. Open Command Prompt in the project folder and create the database:
   `mysql -u root -p < database\schema.sql`
3. Backend:
   `cd server` -> `copy .env.example .env` -> open `.env` in Notepad and fill in your MySQL password, a long random JWT_SECRET, ADMIN_EMAIL and ADMIN_PASSWORD (keep the password in double quotes) -> `npm install` -> `npm run seed` -> `npm start`
4. Frontend (second Command Prompt): `cd client` -> `npm install` -> `npm run dev`
5. Open http://localhost:5173 and sign in with the ADMIN_EMAIL / ADMIN_PASSWORD from your `.env`.

## What works (tested against a real database through the API)
- Login (JWT, bcrypt), owner/staff roles, staff accounts (create, disable), change password API
- Medicines: add, search (name/generic/barcode), archive. Edit exists in the API only.
- Batches with expiry status; stock adjustment API with reason and audit log
- Purchases (transactional, creates batches + stock movements; duplicate batch numbers rejected)
- Billing/POS: server re-checks expiry and stock, row locking, duplicate-submit protection, rollback on failure, tax calculated on the server
- Sales history with search/filters, full-sale return (stock restored, audit + movement records)
- Dashboard (live stats, 7-day chart), notifications (read/unread), analytics API, CSV export (sales, inventory, purchases; owner only)

## Not finished
- Pages not built yet: Analytics page, Settings page, Profile page (their APIs exist)
- No medicine edit form, no stock-adjustment form, no discount field in POS
- No PDF invoice (browser Print only), no partial returns, no demand forecast, no assistant, no barcode camera
- The UI was only compile-checked: it has NOT been viewed in a browser, so layout, mobile and visual polish are unverified
- shadcn/ui is not used (Tailwind + Framer Motion + Recharts + Lucide only)

## API (all except login/health need `Authorization: Bearer <token>`; (owner) = admin only)
auth/login, auth/change-password, me, users (owner), medicines, batches, stock/adjust (owner), suppliers, purchases (owner create), sales, sales/:id, sales/:id/return (owner), sales-search, dashboard, dashboard/trend, analytics, notifications, notifications/read-all, notifications/:id/read, settings (owner edit), export/:sales|inventory|purchases (owner)
