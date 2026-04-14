import { describe, it, expect } from "bun:test";
import {
  getSortedAccountCostRows,
  getAccountCostTotals,
  hasAnyAccountCostData,
} from "../account-cost-table-utils";

interface AccountCostRow {
  name: string;
  planCostUsd: number;
  apiCostUsd: number;
  totalCostUsd: number;
}

describe("account-cost-table-utils", () => {
  describe("getSortedAccountCostRows", () => {
    it("should sort rows by totalCostUsd in descending order", () => {
      const rows: AccountCostRow[] = [
        {
          name: "low-cost-account",
          planCostUsd: 5,
          apiCostUsd: 5,
          totalCostUsd: 10,
        },
        {
          name: "high-cost-account",
          planCostUsd: 30,
          apiCostUsd: 20,
          totalCostUsd: 50,
        },
      ];

      const sorted = getSortedAccountCostRows(rows);

      expect(sorted[0].name).toBe("high-cost-account");
      expect(sorted[0].totalCostUsd).toBe(50);
      expect(sorted[1].name).toBe("low-cost-account");
      expect(sorted[1].totalCostUsd).toBe(10);
    });

    it("should return empty array for empty input", () => {
      const sorted = getSortedAccountCostRows([]);

      expect(sorted).toEqual([]);
    });

    it("should not mutate the original array", () => {
      const rows: AccountCostRow[] = [
        {
          name: "account-1",
          planCostUsd: 10,
          apiCostUsd: 5,
          totalCostUsd: 15,
        },
        {
          name: "account-2",
          planCostUsd: 20,
          apiCostUsd: 15,
          totalCostUsd: 35,
        },
      ];

      const originalOrder = rows.map((r) => r.name);
      getSortedAccountCostRows(rows);

      expect(rows.map((r) => r.name)).toEqual(originalOrder);
    });

    it("should preserve relative order for rows with equal totalCostUsd (stable sort)", () => {
      const rows: AccountCostRow[] = [
        {
          name: "account-a",
          planCostUsd: 10,
          apiCostUsd: 5,
          totalCostUsd: 15,
        },
        {
          name: "account-b",
          planCostUsd: 7,
          apiCostUsd: 8,
          totalCostUsd: 15,
        },
        {
          name: "account-c",
          planCostUsd: 20,
          apiCostUsd: 0,
          totalCostUsd: 20,
        },
      ];

      const sorted = getSortedAccountCostRows(rows);

      // Verify stable sort: account-a should come before account-b since they have equal cost
      expect(sorted[0].name).toBe("account-c");
      expect(sorted[1].name).toBe("account-a");
      expect(sorted[2].name).toBe("account-b");
    });
  });

  describe("getAccountCostTotals", () => {
    it("should sum planCostUsd, apiCostUsd, and totalCostUsd across all rows", () => {
      const rows: AccountCostRow[] = [
        {
          name: "account-1",
          planCostUsd: 10,
          apiCostUsd: 5,
          totalCostUsd: 15,
        },
        {
          name: "account-2",
          planCostUsd: 20,
          apiCostUsd: 15,
          totalCostUsd: 35,
        },
      ];

      const totals = getAccountCostTotals(rows);

      expect(totals.planCostUsd).toBe(30);
      expect(totals.apiCostUsd).toBe(20);
      expect(totals.totalCostUsd).toBe(50);
    });

    it("should return zero totals for empty array", () => {
      const totals = getAccountCostTotals([]);

      expect(totals.planCostUsd).toBe(0);
      expect(totals.apiCostUsd).toBe(0);
      expect(totals.totalCostUsd).toBe(0);
    });
  });

  describe("hasAnyAccountCostData", () => {
    it("should return false when all totalCostUsd values are zero", () => {
      const rows: AccountCostRow[] = [
        {
          name: "empty-account",
          planCostUsd: 0,
          apiCostUsd: 0,
          totalCostUsd: 0,
        },
      ];

      const hasData = hasAnyAccountCostData(rows);

      expect(hasData).toBe(false);
    });

    it("should return true when any totalCostUsd value is non-zero", () => {
      const rows: AccountCostRow[] = [
        {
          name: "account-with-cost",
          planCostUsd: 5,
          apiCostUsd: 0,
          totalCostUsd: 5,
        },
      ];

      const hasData = hasAnyAccountCostData(rows);

      expect(hasData).toBe(true);
    });

    it("should return false for empty array", () => {
      const hasData = hasAnyAccountCostData([]);

      expect(hasData).toBe(false);
    });
  });
});
