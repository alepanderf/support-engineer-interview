"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { trpc } from "@/lib/trpc/client";

interface FundingModalProps {
  accountId: number;
  onClose: () => void;
  onSuccess: () => void;
}

type FundingFormData = {
  amount: string;
  fundingType: "card" | "bank";
  accountNumber: string;
  routingNumber?: string;
};

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

  if (/^4\d{12}(\d{3})?(\d{3})?$/.test(digits)) return "visa";

  if (
    /^5[1-5]\d{14}$/.test(digits) ||
    /^2(2[2-9]\d{2}|[3-6]\d{3}|7[01]\d{2}|720\d{2})\d{10}$/.test(digits)
  ) {
    return "mastercard";
  }

  if (/^3[47]\d{13}$/.test(digits)) return "amex";

  if (/^6(?:011|5\d{2}|4[4-9]\d)\d{12}$/.test(digits)) return "discover";

  if (/^35(2[89]|[3-8]\d)\d{12}$/.test(digits)) return "jcb";

  return null;
}


export function FundingModal({ accountId, onClose, onSuccess }: FundingModalProps) {
  const [error, setError] = useState("");
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FundingFormData>({
    defaultValues: {
      fundingType: "card",
    },
  });

  const fundingType = watch("fundingType");
  const fundAccountMutation = trpc.account.fundAccount.useMutation();
  const utils = trpc.useUtils();

  const onSubmit = async (data: FundingFormData) => {
    setError("");

    try {
      const amount = parseFloat(data.amount);

      // Build a properly-typed fundingSource object
      const fundingSource =
      data.fundingType === "card"
        ? {
            type: "card" as const,
            accountNumber: data.accountNumber,
            routingNumber: data.routingNumber, // optional is fine
          }
        : {
            type: "bank" as const,
            accountNumber: data.accountNumber, // code already passes VAL-207
            routingNumber: data.routingNumber!, // required for bank, validation guarantees it
          };

      await fundAccountMutation.mutateAsync({
        accountId,
        amount,
        fundingSource,
      });

      await utils.account.getTransactions.invalidate({ accountId });

      onSuccess();
    } catch (err: any) {
      setError(err.message || "Failed to fund account");
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-500 bg-opacity-75 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-md w-full p-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Fund Your Account</h3>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">Amount</label>
            <div className="mt-1 relative rounded-md shadow-sm">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <span className="text-gray-500 sm:text-sm">$</span>
              </div>
              <input
                {...register("amount", {
                  required: "Amount is required",
                  pattern: {
                    value: /^(0|[1-9]\d*)(\.\d{1,2})?$/,
                    message: "Invalid amount format",
                  },
                  min: {
                    value: 0.01,
                    message: "Amount must be at least $0.01",
                  },
                  max: {
                    value: 10000,
                    message: "Amount cannot exceed $10,000",
                  },
                })}
                type="text"
                className="mt-1 block w-full rounded-md border p-2 sm:text-sm
                bg-white text-gray-900 border-gray-300
                dark:bg-gray-900 dark:text-gray-100 dark:border-gray-600
                focus:ring-blue-500 focus:border-blue-500"
                placeholder="0.00"
              />
            </div>
            {errors.amount && <p className="mt-1 text-sm text-red-600">{errors.amount.message}</p>}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Funding Source</label>
            <div className="space-y-2">
              <label className="flex items-center">
                <input {...register("fundingType")} 
                  type="radio" 
                  value="card" 
                  className="mt-1 block w-full rounded-md border p-2 sm:text-sm
                  bg-white text-gray-900 border-gray-300
                  dark:bg-gray-900 dark:text-gray-100 dark:border-gray-600
                  focus:ring-blue-500 focus:border-blue-500" />
                <span>Credit/Debit Card</span>
              </label>
              <label className="flex items-center">
                <input {...register("fundingType")} 
                  type="radio" 
                  value="bank" 
                  className="mt-1 block w-full rounded-md border p-2 sm:text-sm
                  bg-white text-gray-900 border-gray-300
                  dark:bg-gray-900 dark:text-gray-100 dark:border-gray-600
                  focus:ring-blue-500 focus:border-blue-500" />
                <span>Bank Account</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              {fundingType === "card" ? "Card Number" : "Account Number"}
            </label>
            <input
              {...register("accountNumber", {
                required: `${fundingType === "card" ? "Card" : "Account"} number is required`,
                pattern: {
                  value: fundingType === "card" ? /^\d{13,19}$/ : /^\d+$/,
                  message: fundingType === "card" ? "Card number must be between 13 and 19 digits" : "Invalid account number",
                },
                validate: {
                  validCard: (value) => {
                    if (fundingType !== "card") return true;
                    if (!passesLuhn(value)) {
                      return "Card number failed validation";
                    }
                    const type = detectCardType(value);
                    if (!type) {
                      return "Unsupported or unknown card type";
                    }
                    return true;
                  },
                },
              })}
              type="text"
              className="mt-1 block w-full rounded-md border p-2 sm:text-sm
              bg-white text-gray-900 border-gray-300
              dark:bg-gray-900 dark:text-gray-100 dark:border-gray-600
              focus:ring-blue-500 focus:border-blue-500"
              placeholder={fundingType === "card" ? "1234567812345678" : "123456789"}
            />
            {errors.accountNumber && <p className="mt-1 text-sm text-red-600">{errors.accountNumber.message}</p>}
          </div>

          {fundingType === "bank" && (
            <div>
              <label className="block text-sm font-medium text-gray-700">Routing Number</label>
              <input
                {...register("routingNumber", {
                  required: "Routing number is required",
                  pattern: {
                    value: /^\d{9}$/,
                    message: "Routing number must be 9 digits",
                  },
                })}
                type="text"
                className="mt-1 block w-full rounded-md border p-2 sm:text-sm
                bg-white text-gray-900 border-gray-300
                dark:bg-gray-900 dark:text-gray-100 dark:border-gray-600
                focus:ring-blue-500 focus:border-blue-500"
                placeholder="123456789"
              />
              {errors.routingNumber && <p className="mt-1 text-sm text-red-600">{errors.routingNumber.message}</p>}
            </div>
          )}

          {error && <div className="text-sm text-red-600">{error}</div>}

          <div className="flex justify-end space-x-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={fundAccountMutation.isPending}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 border border-transparent rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {fundAccountMutation.isPending ? "Processing..." : "Fund Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
