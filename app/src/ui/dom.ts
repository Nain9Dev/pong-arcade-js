/**
 * Minimal DOM helpers for the presentation shell.
 *
 * `UiPort.render` runs once per animation frame, so every mutation helper here
 * is a no-op when the value has not changed: writing an identical `textContent`
 * still invalidates layout in some engines, and at 144 Hz that adds up.
 */
type Attributes = Readonly<Record<string, string>>;

export const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Attributes = {},
  children: readonly (Node | string)[] = [],
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'class') node.className = value;
    else node.setAttribute(name, value);
  }
  for (const child of children) node.append(child);
  return node;
};

export const setText = (node: HTMLElement, value: string): void => {
  if (node.textContent !== value) node.textContent = value;
};

/** Sets a stringified boolean ARIA attribute (`aria-pressed`, `aria-modal`…). */
export const setFlag = (node: HTMLElement, name: string, on: boolean): void => {
  const value = on ? 'true' : 'false';
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
};

export const setHidden = (node: HTMLElement, hidden: boolean): void => {
  if (node.hidden !== hidden) node.hidden = hidden;
};

export const setClass = (node: HTMLElement, name: string, on: boolean): void => {
  node.classList.toggle(name, on);
};

/**
 * Tab-reachable descendants, in DOM order. Elements with no client rect are
 * skipped so a collapsed or `display: none` branch never traps the caret.
 */
export const focusablesIn = (scope: HTMLElement): readonly HTMLElement[] => {
  const candidates = scope.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  return Array.from(candidates).filter((node) => node.getClientRects().length > 0);
};
