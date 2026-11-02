// Calls alpha (back-edge — potential cycle). Calls helper (ambiguous name).
import { alpha } from "./fixture-a"

export function beta() {
  alpha()
  helper()
}

export function helper() {
  // no calls — defines one of the two "helper" symbols
}