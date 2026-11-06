import { checkout } from "./index";
export function main() { return checkout({ sku: "book", available: 8 }, 2); }
