// Multiple internal calls from one function.
import { alpha } from "./fixture-a"
import { Service } from "./fixture-c"

export function topLevel() {
  alpha()
  const svc = new Service()
  svc.process()
}