import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The slice of D1 that this bridge actually uses, backed by SQLite so the same
 * `src/db.ts` runs unchanged on a plain server. Nothing here tries to be a
 * complete D1: `prepare`, `bind`, `run`, `first` and `batch` are the whole
 * surface, and anything else would be dead code pretending to be support.
 */

interface PreparedStatement {
  bind(...values: unknown[]): PreparedStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
}

class SqliteStatement implements PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): PreparedStatement {
    this.values = values;
    return this;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    const result = this.statement.run(...(this.values as never[]));
    return { meta: { changes: Number(result.changes) } };
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...(this.values as never[])) as T | undefined) ?? null;
  }
}

export class SqliteD1 {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): PreparedStatement {
    return new SqliteStatement(this.db.prepare(sql));
  }

  async batch(statements: PreparedStatement[]): Promise<unknown[]> {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Applies any migration file not yet recorded, in filename order. */
  applyMigrations(migrations: { name: string; sql: string }[]): string[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");

    const seen = this.db.prepare("SELECT name FROM d1_migrations WHERE name = ?");
    const record = this.db.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)");
    const applied: string[] = [];

    for (const migration of migrations) {
      if (seen.get(migration.name)) {
        continue;
      }

      this.db.exec("BEGIN");
      try {
        this.db.exec(migration.sql);
        record.run(migration.name, Date.now());
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }

      applied.push(migration.name);
    }

    return applied;
  }
}
