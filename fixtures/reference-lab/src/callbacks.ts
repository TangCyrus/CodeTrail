export function each(run: () => number): number {
  return run();
}

export function task(): number { return 7; }

export function schedule(): void {
  each(task); // @check callback-reference
  each(() => task());
}

export function dynamic(target: any): void {
  target();
  target.execute();
}

export function select(flag: boolean): number {
  const chosen = flag ? task : () => 0;
  return chosen();
}
