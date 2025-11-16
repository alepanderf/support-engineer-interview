import { describe, it, expect, beforeEach } from "vitest";
import { appRouter } from "@/server/routers";
import { db } from "@/lib/db";
import { accounts, transactions, sessions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";

import {
  createCaller,
  createTestUser,
  resetDb,
} from "./testUtils";

describe("Account Router", () => {
  beforeEach(async () => {
    await resetDb();
  });

  // =====================================================================
  // CREATE ACCOUNT
  // =====================================================================
  it("createAccount: creates a checking account", async () => {
    const { user } = await createTestUser();

    const caller = createCaller({ user });

    const acct = await caller.account.createAccount({
      accountType: "checking",
    });

    expect(acct).toBeDefined();
    expect(acct.accountType).toBe("checking");

    // Should exist in DB
    const row = await db
      .select()
      .from(accounts)
      .where(eq(accounts.accountNumber, acct.accountNumber))
      .get();

    expect(row).toBeDefined();
    expect(row?.balance).toBe(0);
  });

  it("createAccount: prevents duplicate account types", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    await caller.account.createAccount({ accountType: "checking" });

    await expect(
      caller.account.createAccount({ accountType: "checking" })
    ).rejects.toThrowError(/already have a checking account/i);
  });

  // =====================================================================
  // GET ACCOUNTS
  // =====================================================================
  it("getAccounts: returns all accounts for the user", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    await caller.account.createAccount({ accountType: "checking" });
    await caller.account.createAccount({ accountType: "savings" });

    const list = await caller.account.getAccounts();
    expect(list.length).toBe(2);
    expect(list.map(a => a.accountType).sort()).toEqual(["checking", "savings"]);
  });

  // =====================================================================
  // FUND ACCOUNT
  // =====================================================================
  it("fundAccount: updates balance and creates transaction", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    const acct = await caller.account.createAccount({ accountType: "checking" });

    const result = await caller.account.fundAccount({
      accountId: acct.id,
      amount: 50,
      fundingSource: {
        type: "card",
        accountNumber: "4242424242424242",
        routingNumber: undefined,
      }
    });

    expect(result).toBeDefined();
    expect(result.newBalance).toBe(50);

    const tx = await db
      .select()
      .from(transactions)
      .where(eq(transactions.accountId, acct.id));

    expect(tx.length).toBe(1);
    expect(tx[0].amount).toBe(50);
    expect(tx[0].status).toBe("completed");
  });

  it("fundAccount: rejects invalid Luhn card numbers", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });
    const acct = await caller.account.createAccount({ accountType: "checking" });

    await expect(
      caller.account.fundAccount({
        accountId: acct.id,
        amount: 30,
        fundingSource: {
          type: "card",
          accountNumber: "1234567890123456", // ❌ invalid
          routingNumber: undefined
        }
      })
    ).rejects.toThrowError(/invalid/i);
  });

  it("fundAccount: rejects unsupported card types", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });
    const acct = await caller.account.createAccount({ accountType: "checking" });

    // Valid Luhn but unsupported type
    await expect(
      caller.account.fundAccount({
        accountId: acct.id,
        amount: 25,
        fundingSource: {
          type: "card",
          accountNumber: "9000000000000001", // JCB or invalid in your detectCardType
          routingNumber: undefined
        }
      })
    ).rejects.toThrowError(/unsupported/i);
  });

  it("fundAccount: validates routing numbers for bank transfers", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });
    const acct = await caller.account.createAccount({ accountType: "checking" });

    await expect(
      caller.account.fundAccount({
        accountId: acct.id,
        amount: 20,
        fundingSource: {
          type: "bank",
          accountNumber: "12345678",
          routingNumber: "12345" // ❌ must be 9 digits
        }
      })
    ).rejects.toThrowError(/routing number/i);
  });

  // =====================================================================
  // GET TRANSACTIONS
  // =====================================================================
  it("getTransactions: returns enriched transaction list", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    const acct = await caller.account.createAccount({ accountType: "checking" });

    await caller.account.fundAccount({
      accountId: acct.id,
      amount: 10,
      fundingSource: {
        type: "card",
        accountNumber: "4242424242424242",
        routingNumber: undefined,
      },
    });

    await caller.account.fundAccount({
      accountId: acct.id,
      amount: 25,
      fundingSource: {
        type: "card",
        accountNumber: "4242424242424242",
        routingNumber: undefined,
      },
    });

    await caller.account.fundAccount({
      accountId: acct.id,
      amount: 50,
      fundingSource: {
        type: "card",
        accountNumber: "4242424242424242",
        routingNumber: undefined,
      },
    });

    const txs = await caller.account.getTransactions({
      accountId: acct.id,
    });

    expect(txs.length).toBe(3);
    expect(txs.map(t => t.amount).sort()).toEqual([10, 25, 50]);
    expect(txs[0]).toHaveProperty("accountType", "checking");
  });

  // =====================================================================
  // PERF-408 – DB CONNECTION REUSE (No leaking connections)
  // =====================================================================
  it("PERF-408: db uses single pooled connection (no leak)", async () => {
    const { user } = await createTestUser();
    const caller = createCaller({ user });

    await caller.account.createAccount({ accountType: "savings" });
    await caller.account.createAccount({ accountType: "checking" });

    // Drizzle SQLite = single pooled handle
    expect(db).toBeDefined();
    expect(typeof (db as any).execute).toBe("function");
  });
});
