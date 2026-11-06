import { clean as sanitize, overloaded } from "./barrel";
import { compute as calculate } from "@domain/math";
import type { Payload } from "@domain/math";
import { left } from "./scope/left";
import { right } from "./scope/right";

export function submit(payload: Payload): number {
  const cleaned = sanitize(payload.value); // @check alias-reference
  return calculate(cleaned);
}

export function start(): number {
  return submit({ value: 4 }) + left() + right() + overloaded(2);
}
