import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { protectedProcedure, router } from "../trpc";
import { db } from "@/lib/db";
import { accounts, transactions } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { randomInt } from "crypto";

function generateAccountNumber(): string {
  // Generate a cryptographically secure random 10-digit number
  const num = randomInt(0, 10 ** 10); // 0 to 9,999,999,999 inclusive
  return num.toString().padStart(10, "0");
}

function passesLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\s+/g, "");
  if (!/^\d{13,19}$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = parseInt(digits[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

type CardType = "visa" | "mastercard" | "amex" | "discover" | "jcb";

function detectCardType(cardNumber: string): CardType | null {
  const digits = cardNumber.replace(/\s+/g, "");

  // Visa: 13–16 digits, starting with 4
  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) {
    return "visa";
  }

  // Mastercard:
  // - Old range: 51–55
  // - New range: 2221–2720
  if (
    /^5[1-5]\d{14}$/.test(digits) ||
    /^2(2[2-9]\d{2}|[3-6]\d{3}|7[01]\d{2}|720\d{2})\d{10}$/.test(digits)
  ) {
    return "mastercard";
  }

  // American Express: 34 or 37, 15 digits
  if (/^3[47]\d{13}$/.test(digits)) {
    return "amex";
  }

  // Discover: 6011, 65, 644–649 (common ranges)
  if (/^6(?:011|5\d{2}|4[4-9]\d)\d{12}$/.test(digits)) {
    return "discover";
  }

  // JCB: 3528–3589, 16 digits (simplified)
  if (/^35(2[89]|[3-8]\d)\d{12}$/.test(digits)) {
    return "jcb";
  }

  return null;
}

const cardFundingSchema = z.object({
  type: z.literal("card"),
  accountNumber: z
    .string()
    .refine(passesLuhn, { message: "Card number is invalid" })
    .refine((val) => detectCardType(val) !== null, {
      message: "Unsupported or unknown card type",
    }),
  routingNumber: z.string().optional(),
});

const bankFundingSchema = z.object({
  type: z.literal("bank"),
  accountNumber: z.string(), // can add more rules separately
  routingNumber: z
    .string()
    .regex(/^\d{9}$/, { message: "Routing number must be 9 digits" }), // US routing number format
});

const fundingSourceSchema = z.discriminatedUnion("type", [
  cardFundingSchema,
  bankFundingSchema,
]);

export const accountRouter = router({
  createAccount: protectedProcedure
    .input(
      z.object({
        accountType: z.enum(["checking", "savings"]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Check if user already has an account of this type
      const existingAccount = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.userId, ctx.user.id), eq(accounts.accountType, input.accountType)))
        .get();

      if (existingAccount) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `You already have a ${input.accountType} account`,
        });
      }

      let accountNumber;
      let isUnique = false;

      // Generate unique account number
      while (!isUnique) {
        accountNumber = generateAccountNumber();
        const existing = await db.select().from(accounts).where(eq(accounts.accountNumber, accountNumber)).get();
        isUnique = !existing;
      }

      await db.insert(accounts).values({
        userId: ctx.user.id,
        accountNumber: accountNumber!,
        accountType: input.accountType,
        balance: 0,
        status: "active",
      });

      // Fetch the created account
      const account = await db.select().from(accounts).where(eq(accounts.accountNumber, accountNumber!)).get();

      if(!account) {
        // If we get here, something went wrong with insert or select.
        throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to create account. Please try again.",
        });
      }

      return account;
    }),

  getAccounts: protectedProcedure.query(async ({ ctx }) => {
    const userAccounts = await db.select().from(accounts).where(eq(accounts.userId, ctx.user.id));

    return userAccounts;
  }),

  fundAccount: protectedProcedure
    .input(
      z.object({
        accountId: z.number(),
        amount: z
          .number()
          .positive()
          .refine((val) => val >= 0.01, {
            message: "Amount must be at least $0.01",
          }),
        fundingSource: fundingSourceSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const amount = parseFloat(input.amount.toString());

      // Verify account belongs to user
      const account = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.user.id)))
        .get();

      if (!account) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account not found",
        });
      }

      if (account.status !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Account is not active",
        });
      }

      // Create transaction
      await db.insert(transactions).values({
        accountId: input.accountId,
        type: "deposit",
        amount,
        description: `Funding from ${input.fundingSource.type}`,
        status: "completed",
        processedAt: new Date().toISOString(),
      });

      // Fetch the created transaction
      const transaction = await db.select().from(transactions).orderBy(transactions.createdAt).limit(1).get();

      // Update account balance
      await db
        .update(accounts)
        .set({
          balance: account.balance + amount,
        })
        .where(eq(accounts.id, input.accountId));

      const updatedAccount = await db
        .select()
        .from(accounts)
        .where(eq(accounts.id, input.accountId))
        .get();

      if (!updatedAccount) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Failed to load updated account balance",
        });
      }

      return {
        transaction,
        newBalance: updatedAccount.balance, // This will be slightly off due to float precision
      };
    }),

  getTransactions: protectedProcedure
    .input(
      z.object({
        accountId: z.number(),
      })
    )
    .query(async ({ input, ctx }) => {
      // Verify account belongs to user
      const account = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.accountId), eq(accounts.userId, ctx.user.id)))
        .get();

      if (!account) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Account not found",
        });
      }

      const accountTransactions = await db
        .select()
        .from(transactions)
        .where(eq(transactions.accountId, input.accountId));

      const enrichedTransactions = [];
      for (const transaction of accountTransactions) {
        const accountDetails = await db.select().from(accounts).where(eq(accounts.id, transaction.accountId)).get();

        enrichedTransactions.push({
          ...transaction,
          accountType: accountDetails?.accountType,
        });
      }

      return enrichedTransactions;
    }),
});
