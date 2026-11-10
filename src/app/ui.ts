/** Small DOM helpers shared by the page's parts. */

/** The element with this id; the page is broken without it, so a missing one throws. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`#${id} is missing from the page`);
  return element as T;
}

/** The first match inside `root`, or a throw: the markup comes from our own template. */
export function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) throw new Error(`${selector} is missing`);
  return element as T;
}

let toastTimer = 0;

/** A message at the bottom of the page for a few seconds, instead of alert(). */
export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const box = byId('toast');
  box.textContent = message;
  box.classList.toggle('is-error', kind === 'error');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    box.hidden = true;
  }, kind === 'error' ? 6000 : 2600);
}

/** Replaces a select's options: [value, label] pairs, `selected` chosen. */
export function fillSelect(select: HTMLSelectElement, options: [string, string][], selected: string): void {
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      return option;
    }),
  );
}
