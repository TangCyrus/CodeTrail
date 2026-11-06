import { submit } from "../src/order";
export function checkSubmit() { if (submit(2) !== 2) throw new Error("unexpected amount"); }
