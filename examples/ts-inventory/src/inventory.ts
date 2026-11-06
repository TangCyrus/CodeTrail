import type { Product, Reservation } from "./model";

export function reserve(product: Product, quantity: number): Reservation {
  if (quantity < 1 || product.available < quantity) throw new Error("insufficient stock");
  return { sku: product.sku, quantity, remaining: product.available - quantity };
}
