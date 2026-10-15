import { PrismaClient } from "@prisma/client";
const shared = globalThis as unknown as { db?: PrismaClient };
export const db = shared.db ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") shared.db = db;
