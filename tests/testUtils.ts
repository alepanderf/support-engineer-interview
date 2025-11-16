import { appRouter } from "@/server/routers";
import type { Context } from "@/server/trpc";
import { db } from "@/lib/db";
import { users, accounts, sessions, transactions } from "@/lib/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";

export async function resetDb() {
  await db.delete(transactions);
  await db.delete(accounts);
  await db.delete(sessions);
  await db.delete(users);
}

export function createCaller(ctxOverride: Partial<Context> = {}) {
  const baseCtx: Context = {
    user: null,
    req: { headers: {}, cookies: {} } as any,
    res: { setHeader: () => {} } as any,
  };

  return appRouter.createCaller({ ...baseCtx, ...ctxOverride } as Context);
}

export async function createTestUser(
  overrides: Partial<typeof users.$inferInsert> = {}
) {
  const passwordPlain =
    (overrides.password as string | undefined) ?? "Aa1!good!";
  const hashedPassword = await bcrypt.hash(passwordPlain, 10);

  const email = (overrides.email as string | undefined) ?? `test${Math.random().toString(36).slice(2)}@example.com`;

  await db.insert(users).values({
    email,
    firstName: "Test",
    lastName: "User",
    ssn: "000000000",
    phoneNumber: "+14155550123",
    dateOfBirth: "1990-01-01",
    address: "123 Main St",
    city: "Somewhere",
    state: "NJ",
    zipCode: "07001",
    ...overrides,
    password: hashedPassword,
  });

  const user = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .get();

  return { user: user!, passwordPlain };
}