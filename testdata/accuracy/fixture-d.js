// Self-recursion (walk → walk). Mutual recursion (odd ↔ even).
function walk(n) {
  if (n > 0) walk(n - 1)
}

function odd() {
  even()
}

function even() {
  odd()
}