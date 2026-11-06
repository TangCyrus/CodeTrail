import { checkout } from "../src/checkout";
export function checkReservation() {
  const result = checkout({ sku: "book", available: 8 }, 2);
  if (result.remaining !== 6) throw new Error("incorrect reservation");
}
