// Cross-file call to beta. External call to externalLib (not in index).
import { beta } from "./fixture-b"

export function alpha() {
  beta()
  externalLib()
}