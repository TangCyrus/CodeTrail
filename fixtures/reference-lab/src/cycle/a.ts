import { b } from "./b";
export function a(depth: number): number { return depth > 0 ? b(depth - 1) : 0; }
