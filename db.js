const { Pool } = require("pg");

const databaseUrl = process.env.DATABASE_URL || "";
const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

let schemaPromise = null;

async function ensureSchema() {
  if (!pool) {
    throw new Error("DATABASE_URL が設定されていません。");
  }
  if (!schemaPromise) {
    schemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS app_states (
        client_id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `).catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

async function getAppState(clientId) {
  await ensureSchema();
  const result = await pool.query(
    "SELECT data, updated_at FROM app_states WHERE client_id = $1",
    [clientId]
  );
  return result.rows[0] || null;
}

async function saveAppState(clientId, data) {
  await ensureSchema();
  const result = await pool.query(
    `INSERT INTO app_states (client_id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (client_id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING updated_at`,
    [clientId, JSON.stringify(data)]
  );
  return result.rows[0];
}

async function checkDatabase() {
  await ensureSchema();
  const result = await pool.query("SELECT NOW() AS now");
  return result.rows[0];
}

module.exports = {
  pool,
  databaseConfigured: Boolean(databaseUrl),
  ensureSchema,
  getAppState,
  saveAppState,
  checkDatabase,
};
