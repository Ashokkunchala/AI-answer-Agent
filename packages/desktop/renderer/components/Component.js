// Base Component class for all UI components
export class Component {
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    this.options = options;
    this.el = null;
    this._listeners = [];
    this._intervals = [];
    this._timeouts = [];
    this.state = {};
  }

  render() {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = this.constructor.name;
    }
    return this.el;
  }

  mount(parent) {
    const target = parent || this.container;
    if (target && this.el) target.appendChild(this.el);
  }

  update(state) {
    Object.assign(this.state, state);
    this.onUpdate(state);
  }

  onUpdate(_state) {}

  destroy() {
    for (const [el, event, handler] of this._listeners) {
      el.removeEventListener(event, handler);
    }
    this._listeners = [];
    for (const id of this._intervals) clearInterval(id);
    for (const id of this._timeouts) clearTimeout(id);
    if (this.el && this.el.parentNode) this.el.parentNode.removeChild(this.el);
  }

  on(el, event, handler) {
    el.addEventListener(event, handler);
    this._listeners.push([el, event, handler]);
  }

  setInterval(fn, ms) {
    const id = setInterval(fn, ms);
    this._intervals.push(id);
    return id;
  }

  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    this._timeouts.push(id);
    return id;
  }

  emit(eventName, detail) {
    this.el.dispatchEvent(new CustomEvent(eventName, { detail, bubbles: true }));
  }

  $(selector) {
    return this.el ? this.el.querySelector(selector) : null;
  }

  $$(selector) {
    return this.el ? this.el.querySelectorAll(selector) : [];
  }

  static css = '';
}
