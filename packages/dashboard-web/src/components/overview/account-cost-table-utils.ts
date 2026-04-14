export interface AccountCostRow {
  name: string;
  planCostUsd: number;
  apiCostUsd: number;
  totalCostUsd: number;
}

export interface AccountCostTotals {
  planCostUsd: number;
  apiCostUsd: number;
  totalCostUsd: number;
}

/**
 * Sorts account cost rows by totalCostUsd in descending order (highest cost first)
 */
export function getSortedAccountCostRows(
  rows: AccountCostRow[]
): AccountCostRow[] {
  return [...rows].sort((a, b) => b.totalCostUsd - a.totalCostUsd);
}

/**
 * Computes aggregate totals across all account cost rows
 */
export function getAccountCostTotals(
  rows: AccountCostRow[]
): AccountCostTotals {
  return rows.reduce(
    (acc, row) => ({
      planCostUsd: acc.planCostUsd + row.planCostUsd,
      apiCostUsd: acc.apiCostUsd + row.apiCostUsd,
      totalCostUsd: acc.totalCostUsd + row.totalCostUsd,
    }),
    {
      planCostUsd: 0,
      apiCostUsd: 0,
      totalCostUsd: 0,
    }
  );
}

// Epsilon threshold for cost comparison to handle floating-point precision
// Using sub-cent threshold to ignore negligible rounding artifacts
const EPSILON = 0.0001;

/**
 * Detects if there is any non-zero cost data across all rows
 * Returns false when all totalCostUsd values are at or below EPSILON, true otherwise
 */
export function hasAnyAccountCostData(rows: AccountCostRow[]): boolean {
  return rows.some((row) => row.totalCostUsd > EPSILON);
}
