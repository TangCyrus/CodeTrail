export function shared(): number { return 1; }
export function left(): number { return shared(); }

export function nested(): number {
  function shared(): number { return 3; }
  return shared(); // @check nested-reference
}
