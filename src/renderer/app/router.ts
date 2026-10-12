export type Section = 'home' | 'models' | 'settings';

const listeners = new Set<(s: Section) => void>();
let current: Section = 'home';

export function navigate(s: Section) {
  current = s;
  for (const l of listeners) l(s);
}

export function onNavigate(fn: (s: Section) => void) {
  listeners.add(fn);
}

export function currentSection() {
  return current;
}
