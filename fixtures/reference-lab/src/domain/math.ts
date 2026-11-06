export interface Payload { value: number }

export function normalize(value: number): number {
  return value < 0 ? 0 : value;
}

export function compute(value: number): number {
  return normalize(value) * 2;
}

export function overloaded(value: number): number;
export function overloaded(value: string): string;
export function overloaded(value: number | string): number | string {
  return value;
}
