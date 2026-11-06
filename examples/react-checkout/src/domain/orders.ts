import { applyDiscount, calculateTotal, type LineItem } from "./pricing";
export interface Receipt { amount: number; lines: number; }

export function createOrder(items: readonly LineItem[], discount: number): Receipt {
  const total = calculateTotal(items);
  return { amount: applyDiscount(total, discount), lines: items.length };
}
