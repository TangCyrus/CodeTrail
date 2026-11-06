import { legacyDiscount } from "@pricing/legacy";
export function legacyOrder(value: number) { return legacyDiscount(value); }
