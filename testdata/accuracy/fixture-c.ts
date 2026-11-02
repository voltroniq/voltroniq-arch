// Class with two methods. Calls "helper" (a method of this class —
// ambiguous because fixture-b also has a `helper` function).
export class Service {
  helper() {
    // no calls — defines the second "helper"
  }

  process() {
    this.helper()
  }
}