import { absent } from "./not-here";
import { hidden } from "./hidden";
export function missing() { return absent() + hidden(); }
