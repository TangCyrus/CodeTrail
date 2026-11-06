export interface LineItem { sku: string; quantity: number; price: number; }

export function calculateTotal(items: readonly LineItem[]): number {
  return items.reduce((total, item) => total + item.quantity * item.price, 0);
}

export function applyDiscount(total: number, discount: number): number {
  return total > discount ? total - discount : 0;
}
