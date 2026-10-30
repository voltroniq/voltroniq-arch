function handleUser(u) {
  return u.name;
}

const handleUserArrow = (u) => u.name;

class UserService {
  getName() { return "x"; }
  static create() { return new UserService(); }
}

const fake = "function notARealFunction() {}";
// function alsoNotReal() {}