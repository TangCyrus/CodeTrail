export class Service {
  save(value: number): number { return value; }
}
const service = new Service();
export function persist(): number { return service.save(1); }
