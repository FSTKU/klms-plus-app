const { ensureSchema, pool } = require("../db");

(async () => {
  try {
    await ensureSchema();
    console.log("Database schema is ready: app_states");
  } catch (error) {
    console.error("Database initialization failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
})();
