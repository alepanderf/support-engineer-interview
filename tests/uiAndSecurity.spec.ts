import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/routers";
import { db } from "@/lib/db";
import { users, transactions, sessions } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

import {
  createCaller,
  createTestUser,
  resetDb,
} from "./testUtils";

// For SEC-303 XSS tests
const MALICIOUS_INPUT = `<script>alert("owned")</script>`;

describe("UI & Security Tests", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // =====================================================================
  // UI-101 — Dark Mode Text Visibility
  // =====================================================================
  it("UI-101: form inputs should include Tailwind classes that ensure visibility in dark mode", async () => {
    // The app uses Tailwind. We cannot render a browser in Vitest (no jsdom),
    // so instead we verify that the expected CSS classes exist in the UI code.

    // We load the file directly as text
    const fs = await import("fs");
    const path = await import("path");

    const formPath = path.resolve(process.cwd(), "app/register/page.tsx");
    const content = fs.readFileSync(formPath, "utf8");

    expect(content).toMatch(/dark:text-(white|gray)/i);
    expect(content).toMatch(/dark:bg-(gray|neutral)/i);
  });

  // =====================================================================
  // SEC-301 — SSN is hashed / never plaintext in DB
  // =====================================================================
  it("SEC-301: SSN should be hashed in the database", async () => {
    const { user } = await createTestUser({ ssn: "123456789" });

    const row = await db
      .select()
      .from(users)
      .where(eq(users.id, user.id))
      .get();

    // Should NOT be stored as raw SSN
    expect(row?.ssn).not.toBe("123456789");
    expect(row?.ssn).toMatch(/^\$2[aby]\$.{56}$/); // bcrypt pattern
  });

  // =====================================================================
  // SEC-303 — XSS Sanitization on Transaction Descriptions
  // =====================================================================
  it("SEC-303: transaction descriptions are escaped to prevent XSS injection", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    // Create account
    const acct = await caller.account.createAccount({
      accountType: "checking",
    });

    // Insert an XSS payload via funding description
    await db.insert(transactions).values({
      accountId: acct.id,
      type: "deposit",
      amount: 10,
      description: MALICIOUS_INPUT, // raw XSS attempt
      status: "completed",
      processedAt: new Date().toISOString(),
    });

    const txs = await caller.account.getTransactions({
      accountId: acct.id,
    });

    expect(txs.length).toBe(1);

    // Should NOT return raw <script> tags to the client
    expect(txs[0].description).not.toBe(MALICIOUS_INPUT);
    expect(txs[0].description).not.toMatch(/<script>/i);

    // Should be escaped
    expect(txs[0].description).toMatch(/&lt;script&gt;/i);
  });

  // =====================================================================
  // SEC-304 — Session Management (invalidate old sessions)
  // =====================================================================
  it("SEC-304: login should invalidate older sessions for same user", async () => {
    const { user, passwordPlain } = await createTestUser();

    const caller = createCaller({ user: null });

    // Login #1 → first session
    const login1 = await caller.auth.login({
      email: user.email,
      password: passwordPlain,
    });

    const session1 = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, login1.token))
      .get();

    expect(session1).toBeDefined();

    // Login #2 → second session (should invalidate the first)
    const login2 = await caller.auth.login({
      email: user.email,
      password: passwordPlain,
    });

    const session2 = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, login2.token))
      .get();

    expect(session2).toBeDefined();

    // Old session should be deleted
    const oldStillExists = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, login1.token))
      .get();

    expect(oldStillExists).toBeUndefined();

    // New session should remain valid
    const newStillExists = await db
      .select()
      .from(sessions)
      .where(eq(sessions.token, login2.token))
      .get();

    expect(newStillExists).toBeDefined();
  });

  // =====================================================================
  // SEC-304 — Expired sessions should not authenticate users
  // =====================================================================
  it("SEC-304: expired sessions should not authenticate user via createCaller", async () => {
    const { user } = await createTestUser();

    // Create a fake expired session
    await db.insert(sessions).values({
      userId: user.id,
      token: "expired-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(), // expired 1 min ago
    });

    // Inject cookie into request context
    const caller = createCaller({
      req: {
        headers: {
          cookie: "session=expired-token",
        },
      } as any,
    });

    // Now any protected call should fail as UNAUTHORIZED
    await expect(
      caller.account.getAccounts()
    ).rejects.toThrowError(/unauthorized/i);
  });
});
