require('dotenv').config();
const { Pool, types } = require('pg');
// Make Postgres return the same shapes the app expects (numbers, plain date strings)
types.setTypeParser(1700, (v) => parseFloat(v));      // NUMERIC/DECIMAL -> number
types.setTypeParser(20, (v) => parseInt(v, 10));      // BIGINT (COUNT/SUM) -> number
types.setTypeParser(1082, (v) => v);                  // DATE -> 'YYYY-MM-DD'
types.setTypeParser(1114, (v) => v.slice(0, 19));     // TIMESTAMP -> 'YYYY-MM-DD HH:MM:SS'

const url = process.env.DATABASE_URL || '';
const local = /@(localhost|127\.0\.0\.1)/.test(url);
const pool = new Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
module.exports = pool;
