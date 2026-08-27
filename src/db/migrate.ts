// Migration runner CLI — applies and rolls back .sql migrations from migrations/.
// Usage: npx tsx src/db/migrate.ts up|down [--all]
//   npm run migrate:up    → tsx src/db/migrate.ts up
//   npm run migrate:down  → tsx src/db/migrate.ts down

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import type { Pool as PoolType, QueryResult } from "pg";

const { Pool } = pg;

interface MigrationRecord {
  id: number;
  name: string;
  applied_at: Date;
  status: string;
}

function getPool(): PoolType {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Configure it in .env or export it before running migrations."
    );
  }
  return new Pool({ connectionString: databaseUrl });
}

function getMigrationsDir(): string {
  return path.resolve(process.cwd(), "migrations");
}

function parseMigrationFile(filePath: string): { up: string; down: string } {
  const content = fs.readFileSync(filePath, "utf-8");

  const upMatch = content.match(/--\s*UP:\s*\n([\s\S]*?)(?=\n--\s*DOWN:|$)/i);
  const downMatch = content.match(/--\s*DOWN:\s*\n([\s\S]*?)$/i);

  const up = upMatch && upMatch[1] ? upMatch[1].trim() : "";
  const down = downMatch && downMatch[1] ? downMatch[1].trim() : "";

  return { up, down };
}

function listMigrationFiles(): string[] {
  const dir = getMigrationsDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files;
}

async function ensureMigrationsTable(pool: PoolType): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT now(),
      status TEXT NOT NULL CHECK (status IN ('applied', 'rolled_back'))
    )
  `);
}

async function getAppliedMigrations(pool: PoolType): Promise<string[]> {
  const result: QueryResult<{ name: string }> = await pool.query(
    "SELECT name FROM migrations WHERE status = 'applied' ORDER BY name ASC"
  );
  return result.rows.map((row) => row.name);
}

async function up(): Promise<void> {
  const pool = getPool();
  try {
    await ensureMigrationsTable(pool);
    const applied = new Set(await getAppliedMigrations(pool));
    const migrationFiles = listMigrationFiles();

    if (migrationFiles.length === 0) {
      console.log("No migration files found in migrations/");
      return;
    }

    let appliedCount = 0;
    for (const fileName of migrationFiles) {
      if (applied.has(fileName)) {
        continue;
      }

      const filePath = path.join(getMigrationsDir(), fileName);
      const { up: upSql } = parseMigrationFile(filePath);
      if (!upSql) {
        console.warn(`[migrate] Skipping ${fileName} — no UP section found`);
        continue;
      }

      const client = await pool.connect();
      try {
        console.log(`Applying migration ${fileName}...`);
        await client.query("BEGIN");
        await client.query(upSql);
        await client.query(
          "INSERT INTO migrations (name, status) VALUES ($1, 'applied')",
          [fileName]
        );
        await client.query("COMMIT");
        console.log(`Migration ${fileName} applied.`);
        appliedCount++;
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] Failed to apply ${fileName}:`, err);
        process.exit(1);
      } finally {
        client.release();
      }
    }

    if (appliedCount === 0) {
      console.log("No migrations to apply.");
    } else {
      console.log(`${appliedCount} migration(s) applied.`);
    }
  } finally {
    await pool.end();
  }
}

async function down(all: boolean): Promise<void> {
  const pool = getPool();
  try {
    await ensureMigrationsTable(pool);
    const appliedRows: QueryResult<MigrationRecord> = await pool.query(
      "SELECT id, name FROM migrations WHERE status = 'applied' ORDER BY applied_at DESC"
    );

    const firstRow = appliedRows.rows[0];
    if (!firstRow) {
      console.log("No migrations to roll back.");
      return;
    }

    const toRollback = all ? appliedRows.rows : [firstRow];

    for (const record of toRollback) {
      const filePath = path.join(getMigrationsDir(), record.name);
      if (!fs.existsSync(filePath)) {
        console.warn(`[migrate] Migration file ${record.name} not found, skipping.`);
        continue;
      }

      const { down: downSql } = parseMigrationFile(filePath);
      if (!downSql) {
        console.warn(`[migrate] Skipping ${record.name} — no DOWN section found`);
        continue;
      }

      const client = await pool.connect();
      try {
        console.log(`Rolling back migration ${record.name}...`);
        await client.query("BEGIN");
        await client.query(downSql);
        await client.query(
          "DELETE FROM migrations WHERE name = $1 AND status = 'applied'",
          [record.name]
        );
        await client.query("COMMIT");
        console.log(`Migration ${record.name} rolled back.`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`[migrate] Failed to roll back ${record.name}:`, err);
        process.exit(1);
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    console.error("Usage: tsx src/db/migrate.ts up|down [--all]");
    process.exit(1);
  }

  if (command === "up") {
    await up();
  } else if (command === "down") {
    const all = args.includes("--all");
    await down(all);
  } else {
    console.error(`Unknown command: ${command}`);
    console.error("Usage: tsx src/db/migrate.ts up|down [--all]");
    process.exit(1);
  }
}

void main();
