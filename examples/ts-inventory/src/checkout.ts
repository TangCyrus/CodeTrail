import { reserve } from "./inventory";
import type { Product } from "./model";

export function checkout(product: Product, quantity: number) {
  return reserve(product, quantity);
}
