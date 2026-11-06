export interface ButtonProps { onClick: () => number }
export function Button(props: ButtonProps) {
  return props.onClick();
}
