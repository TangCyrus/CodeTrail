import { normalize, type Payload } from "./domain/math";
export const useMixed = (payload: Payload): number => normalize(payload.value);
