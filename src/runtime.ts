/**
 * The parts of the runtime the bridge actually touches, declared locally so
 * `src/` compiles the same whether the host is workerd or Node. Depending on
 * Cloudflare's ambient types here would mean the Node build could not be
 * typechecked without generating them first.
 */

export interface BridgeExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

export interface BridgeScheduledController {
  scheduledTime?: number;
  cron?: string;
}

export interface BridgePreparedStatement {
  bind(...values: unknown[]): BridgePreparedStatement;
  run(): Promise<{ meta: { changes: number } }>;
  first<T>(): Promise<T | null>;
}

/** D1 and the SQLite adapter both satisfy this; nothing else is used. */
export interface BridgeDatabase {
  prepare(sql: string): BridgePreparedStatement;
  batch(statements: BridgePreparedStatement[]): Promise<unknown[]>;
}
