/** Generic sheet DOM building blocks shared by the core and system client modules. */
export function sheetSection(title: string, className: string): HTMLElement {
  const section = document.createElement('section');
  section.className = `sheet-section ${className}`;
  const heading = document.createElement('h3');
  heading.textContent = title;
  section.append(heading);
  return section;
}

export function makeRowButton(label: string, title: string, action: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = danger ? 'sheet-row-button danger-text' : 'sheet-row-button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', action);
  return button;
}

export function makeStepper(
  value: number, min: number, max: number, label: string,
  onChange: (value: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-stepper';
  const minus = document.createElement('button');
  minus.type = 'button';
  minus.textContent = '−';
  minus.setAttribute('aria-label', `Уменьшить ${label}`);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  const plus = document.createElement('button');
  plus.type = 'button';
  plus.textContent = '+';
  plus.setAttribute('aria-label', `Увеличить ${label}`);
  const emit = (next: number) => {
    const bounded = Math.max(min, Math.min(max, Math.round(next)));
    input.value = String(bounded);
    onChange(bounded);
  };
  const numberFromInput = (inputElement: HTMLInputElement, fallback: number): number => {
    const parsed = Number(inputElement.value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  minus.addEventListener('click', () => emit(numberFromInput(input, value) - 1));
  plus.addEventListener('click', () => emit(numberFromInput(input, value) + 1));
  input.addEventListener('change', () => emit(numberFromInput(input, value)));
  wrap.append(minus, input, plus);
  return wrap;
}

export function moveIds<T extends { id: string; orderIndex: number }>(items: T[], id: string, direction: -1 | 1): string[] | undefined {
  const sorted = [...items].sort((left, right) => left.orderIndex - right.orderIndex);
  const index = sorted.findIndex((item) => item.id === id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= sorted.length) return undefined;
  const [moving] = sorted.splice(index, 1);
  sorted.splice(target, 0, moving!);
  return sorted.map((item) => item.id);
}

export function sheetInitial(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}

export function makeSheetPortrait(assetId: string | null, name: string, className: string, resolveAssetUrl: (id: string) => string): HTMLElement {
  if (assetId) {
    const image = document.createElement('img');
    image.className = className;
    image.src = resolveAssetUrl(assetId);
    image.alt = `Портрет ${name}`;
    image.loading = 'lazy';
    return image;
  }
  const fallback = document.createElement('span');
  fallback.className = `${className} sheet-portrait-fallback`;
  fallback.textContent = sheetInitial(name);
  fallback.setAttribute('aria-hidden', 'true');
  return fallback;
}
