import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { users, sessions } from "@/lib/db/schema";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { resetDb, createCaller, createTestUser } from "./testUtils";
import { createContext } from "@/server/trpc";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

describe("AUTH ROUTER — VALIDATION & SECURITY", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("VAL-201: normalizes email + rejects .con typo", async () => {
    const caller = createCaller();

    await caller.auth.signup({
      email: "TEST@EXAMPLE.COM",
      password: "Aa1!good!",
      firstName: "Test",
      lastName: "User",
      phoneNumber: "+14155550123",
      dateOfBirth: "1990-01-01",
      ssn: "111111111",
      address: "123 Main St",
      city: "City",
      state: "NJ",
      zipCode: "07001",
    });

    const stored = await db
      .select()
      .from(users)
      .where(eq(users.email, "test@example.com"))
      .get();

    expect(stored).toBeDefined();

    await expect(
      caller.auth.signup({
        email: "oops@example.con",
        password: "Aa1!good!",
        firstName: "Test",
        lastName: "User",
        phoneNumber: "+14155550123",
        dateOfBirth: "1990-01-01",
        ssn: "111111111",
        address: "123 Main St",
        city: "City",
        state: "NJ",
        zipCode: "07001",
      })
    ).rejects.toThrow(/did you mean/i);
  });

  it("VAL-202: rejects future DOB and <18 years old", async () => {
    const caller = createCaller();

    const base = {
      password: "Aa1!good!",
      firstName: "Test",
      lastName: "User",
      phoneNumber: "+14155550123",
      ssn: "111111111",
      address: "123 Main St",
      city: "City",
      state: "NJ",
      zipCode: "07001",
    };

    // Future
    await expect(
      caller.auth.signup({
        ...base,
        email: "future@example.com",
        dateOfBirth: "2999-01-01",
      })
    ).rejects.toThrow(/future/i);

    // Under 18
    const young = new Date(
      new Date().getFullYear() - 10,
      0,
      1
    ).toISOString().slice(0, 10);

    await expect(
      caller.auth.signup({
        ...base,
        email: "young@example.com",
        dateOfBirth: young,
      })
    ).rejects.toThrow(/18/i);
  });

  it("VAL-203: enforces US state codes and uppercases", async () => {
    const caller = createCaller();

    const base = {
      password: "Aa1!good!",
      firstName: "Test",
      lastName: "User",
      phoneNumber: "+14155550123",
      dateOfBirth: "1990-01-01",
      ssn: "111111111",
      address: "123 Main St",
      city: "City",
      zipCode: "07001",
    };

    await expect(
      caller.auth.signup({
        ...base,
        email: "bad@example.com",
        state: "XX",
      })
    ).rejects.toThrow(/state/i);

    await caller.auth.signup({
      ...base,
      email: "good@example.com",
      state: "nj",
    });

    const stored = await db
      .select()
      .from(users)
      .where(eq(users.email, "good@example.com"))
      .get();

    expect(stored!.state).toBe("NJ");
  });

  it("VAL-204: validates E.164 phone format", async () => {
    const caller = createCaller();

    const base = {
      password: "Aa1!good!",
      firstName: "Test",
      lastName: "User",
      dateOfBirth: "1990-01-01",
      ssn: "111111111",
      address: "123 Main St",
      city: "City",
      state: "NJ",
      zipCode: "07001",
    };

    await expect(
      caller.auth.signup({
        ...base,
        email: "badphone@example.com",
        phoneNumber: "5551234",
      })
    ).rejects.toThrow(/international/i);

    await caller.auth.signup({
      ...base,
      email: "goodphone@example.com",
      phoneNumber: "+14155550123",
    });
  });

  it("VAL-208 & SEC-301: password complexity + SSN hashing", async () => {
    const caller = createCaller();

    await expect(
      caller.auth.signup({
        email: "weak@example.com",
        password: "password",
        firstName: "Test",
        lastName: "User",
        phoneNumber: "+14155550123",
        ssn: "111111111",
        address: "123 Main St",
        city: "City",
        state: "NJ",
        dateOfBirth: "1990-01-01",
        zipCode: "07001",
      })
    ).rejects.toThrow();

    await caller.auth.signup({
      email: "strong@example.com",
      password: "Aa1!good!",
      firstName: "Test",
      lastName: "User",
      phoneNumber: "+14155550123",
      ssn: "111111111",
      address: "123 Main St",
      city: "City",
      state: "NJ",
      dateOfBirth: "1990-01-01",
      zipCode: "07001",
    });

    const stored = await db
      .select()
      .from(users)
      .where(eq(users.email, "strong@example.com"))
      .get();

    expect(await bcrypt.compare("111111111", stored!.ssn)).toBe(true);
  });

  it("SEC-304: login invalidates previous sessions", async () => {
    const { user, passwordPlain } = await createTestUser({
      email: "multi@example.com",
    });

    await db.insert(sessions).values({
      userId: user.id,
      token: "old",
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const caller = createCaller();
    await caller.auth.login({ email: user.email, password: passwordPlain });

    const rows = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, user.id));

    expect(rows.length).toBe(1);
    expect(rows[0].token).not.toBe("old");
  });

  it("PERF-402: logout reports when no active session", async () => {
    const caller = createCaller({
      user: { id: 123 } as any,
      req: { headers: {}, cookies: {} } as any,
    });

    const res = await caller.auth.logout();
    expect(res.success).toBe(false);
  });
});

describe("PERF-403 — Session Expiry Window", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("invalidates sessions within the safety window (90s)", async () => {
    const { user } = await createTestUser({
      email: "expiry@example.com",
    });

    await db.insert(sessions).values({
      userId: user.id,
      token: "expiring-token",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    const ctx = await createContext({
        req: new Request("http://localhost", {
          headers: { cookie: "session=expiring-token" },
        }),
        resHeaders: new Headers(),
      } as FetchCreateContextFnOptions);

    expect(ctx.user).toBeNull();

    const remaining = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, "expiring-token"))
      .get();

    expect(remaining).toBeUndefined();
  });
});