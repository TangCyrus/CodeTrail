import { a } from "./a";
export function b(depth: number): number { return depth > 0 ? a(depth - 1) : 0; }
