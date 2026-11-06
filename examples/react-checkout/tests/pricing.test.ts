import { calculateTotal } from "../src/domain/pricing";
export function checkTotal() {
  const result = calculateTotal([{ sku: "book", quantity: 2, price: 30 }]);
  if (result !== 60) throw new Error("incorrect total");
}
