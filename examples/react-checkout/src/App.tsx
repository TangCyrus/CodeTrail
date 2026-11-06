import { CheckoutForm } from "./components/CheckoutForm";
import { createOrder } from "./domain/orders";
import { calculateTotal, type LineItem } from "./domain/pricing";

const cart: LineItem[] = [{ sku: "book", quantity: 2, price: 30 }];
export function App() {
  function handleCheckout() { return createOrder(cart, 5); }
  return <main><h1>结账</h1><CheckoutForm amount={calculateTotal(cart)} onCheckout={handleCheckout}/></main>;
}
