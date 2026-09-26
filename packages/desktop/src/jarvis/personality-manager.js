const DEFAULTS = Object.freeze({
  tone: 'professional',
  verbosity: 'concise',
  proactive: false,
  interviewFirst: true,
});

export class PersonalityManager {
  constructor(initial = {}) {
    this.settings = { ...DEFAULTS, ...initial };
  }

  get() {
    return { ...this.settings };
  }

  update(patch = {}) {
    const allowed = ['tone', 'verbosity', 'proactive', 'interviewFirst'];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) this.settings[key] = patch[key];
    }
    return this.get();
  }
}

export { DEFAULTS as DEFAULT_PERSONALITY };
