import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

export type RecoverySnapshot = { schemaHash: string; tables: { name: string; count: number; hash: string }[] };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function tableIdentifier(name: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) throw Error("Unsupported recovery table identifier.");
  return `public."${name}"`;
}
// Fixture-only, bounded snapshot. Never emit row contents or secrets in a report.
export async function recoverySnapshot(db: PrismaClient): Promise<RecoverySnapshot> {
  return db.$transaction(async tx => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const tables = await tx.$queryRaw<{ name: string }[]>`SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename COLLATE "C"`;
    if (!tables.length || tables.length > 128) throw Error("Unexpected rehearsal table count.");
    const columns = await tx.$queryRaw`SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name COLLATE "C", ordinal_position`;
    const constraints = await tx.$queryRaw`SELECT c.relname AS table_name, k.conname, k.contype::text, k.convalidated, pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname COLLATE "C", k.conname COLLATE "C"`;
    const indexes = await tx.$queryRaw`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename COLLATE "C", indexname COLLATE "C"`;
    const result: RecoverySnapshot = { schemaHash: hash(JSON.stringify({ columns, constraints, indexes })), tables: [] };
    let bytes = 0;
    for (const { name } of tables) {
      const rows = await tx.$queryRawUnsafe<{ row: string }[]>(`SELECT to_jsonb(t)::text AS row FROM ${tableIdentifier(name)} t ORDER BY to_jsonb(t)::text COLLATE "C" LIMIT 10001`);
      if (rows.length > 10000) throw Error("Rehearsal snapshot row limit exceeded.");
      const digest = createHash("sha256");
      for (const { row } of rows) {
        const length = Buffer.byteLength(row); bytes += length;
        if (bytes > 32 * 1024 * 1024) throw Error("Rehearsal snapshot byte limit exceeded.");
        digest.update(`${length}:`).update(row);
      }
      result.tables.push({ name, count: rows.length, hash: digest.digest("hex") });
    }
    return result;
  }, { isolationLevel: "RepeatableRead", timeout: 30000 });
}
export function assertSnapshot(expected: RecoverySnapshot, actual: RecoverySnapshot) {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw Error("Restored schema or row fingerprints differ from the backup checkpoint.");
}
