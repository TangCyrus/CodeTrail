export interface CheckoutFormProps { amount: number; onCheckout: () => void; }

export function CheckoutForm({ amount, onCheckout }: CheckoutFormProps) {
  return <section><h2>确认订单</h2><p>应付金额：{amount}</p><button onClick={onCheckout}>提交订单</button></section>;
}
