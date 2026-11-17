import type { CharacterSheet } from '../../../shared/board.js';
import type { SystemClientContext, SystemClientModule, SystemSheetRenderOptions } from '../../client-contract.js';
import { makeRowButton, makeSheetPortrait, makeStepper, sheetSection } from '../../../client/sheet-dom.js';
import {
  isBrokenHeart,
  NechronicaSheetSchemaError,
  parseNechronicaSheetData,
  type NechronicaAbility,
  type NechronicaBodyPart,
  type NechronicaBodyZone,
  type NechronicaDeployment,
  type NechronicaFetter,
  type NechronicaMemory,
  type NechronicaSheetData,
} from './schema-1.1.0.js';

const ZONES: readonly NechronicaBodyZone[] = ['head', 'arms', 'torso', 'legs'];
const ZONE_LABELS: Record<NechronicaBodyZone, string> = { head: 'Голова', arms: 'Руки', torso: 'Торс', legs: 'Ноги' };
const DEPLOYMENT_LABELS: Record<NechronicaDeployment, string> = { eden: 'Эдем', elysium: 'Элизиум', limbo: 'Лимбо' };
const TAB_LABELS = ['Способности', 'Тело', 'Узы и безумие', 'Инфо', 'Память'] as const;
type Tab = (typeof TAB_LABELS)[number];
type Collection = 'abilities' | 'body' | 'fetters' | 'memories';

interface EditorState {
  collection: Collection;
  id?: string;
  zone?: NechronicaBodyZone;
  assetId: string | null;
  values: Record<string, string>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeled(labelText: string, control: HTMLElement): HTMLElement {
  const label = el('label', 'nechronica-field');
  label.append(el('span', 'nechronica-field-label', labelText), control);
  return label;
}

function textInput(value: string, maxLength: number, onInput: (value: string) => void): HTMLInputElement {
  const input = el('input');
  input.type = 'text';
  input.maxLength = maxLength;
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

function textArea(value: string, maxLength: number, rows: number, onInput: (value: string) => void): HTMLTextAreaElement {
  const area = el('textarea');
  area.maxLength = maxLength;
  area.rows = rows;
  area.value = value;
  area.addEventListener('input', () => onInput(area.value));
  return area;
}

/**
 * Full Nechronica 1.1.0 sheet.
 *
 * All state lives in this per-room closure. The module never reads globals and
 * sends every mutation through the core command channel, so the server remains
 * the source of truth. Roll mechanics are intentionally still a placeholder.
 */
export function createClientModule(): SystemClientModule {
  let context: SystemClientContext | undefined;
  let controls: HTMLElement | undefined;
  let currentSheet: CharacterSheet | undefined;
  let currentOptions: SystemSheetRenderOptions | undefined;
  let activeTab: Tab = 'Способности';
  let editor: EditorState | undefined;
  const expandedEffects = new Set<string>();

  const services = () => context!.services;

  function send(type: string, data: Record<string, unknown>): void {
    if (!currentSheet) return;
    void services().command(type, { ...data, sheetId: currentSheet.id });
  }

  function rerender(): void {
    services().renderSheet();
  }

  function toggleExpanded(key: string): void {
    if (expandedEffects.has(key)) expandedEffects.delete(key);
    else expandedEffects.add(key);
    rerender();
  }

  function effectCell(text: string, key: string): HTMLElement {
    const wrap = el('div', 'nechronica-effect');
    const long = text.length > 140 || text.includes('\n');
    if (expandedEffects.has(key)) wrap.classList.add('is-expanded');
    const body = el('div', 'nechronica-effect-text', text || '—');
    wrap.append(body);
    if (long) {
      const toggle = el('button', 'nechronica-effect-toggle', expandedEffects.has(key) ? 'Свернуть' : 'Развернуть');
      toggle.type = 'button';
      toggle.addEventListener('click', (event) => { event.stopPropagation(); toggleExpanded(key); });
      wrap.append(toggle);
    }
    return wrap;
  }

  function itemKey(collection: Collection, id: string, zone?: NechronicaBodyZone): string {
    return `${collection}:${zone ?? ''}:${id}`;
  }

  function openEditor(collection: Collection, zone?: NechronicaBodyZone, item?: NechronicaAbility | NechronicaBodyPart | NechronicaFetter | NechronicaMemory): void {
    if (!item) {
      editor = { collection, zone, assetId: null, values: {} };
      rerender();
      return;
    }
    if (collection === 'abilities') {
      const ability = item as NechronicaAbility;
      editor = {
        collection, zone, id: ability.id, assetId: ability.imageAssetId,
        values: { name: ability.name, source: ability.source, type: ability.type, timing: ability.timing, cost: ability.cost, range: ability.range, effect: ability.effect },
      };
    } else if (collection === 'body') {
      const part = item as NechronicaBodyPart;
      editor = {
        collection, zone, id: part.id, assetId: part.imageAssetId,
        values: { name: part.name, timing: part.timing, cost: part.cost, range: part.range, effect: part.effect },
      };
    } else if (collection === 'fetters') {
      const fetter = item as NechronicaFetter;
      editor = {
        collection, zone, id: fetter.id, assetId: fetter.imageAssetId,
        values: { target: fetter.target, fetter: fetter.fetter, madness: fetter.madness, description: fetter.description },
      };
    } else {
      const memory = item as NechronicaMemory;
      editor = {
        collection, zone, id: memory.id, assetId: null,
        values: { name: memory.name, number: String(memory.number), content: memory.content },
      };
    }
    rerender();
  }

  function pickAsset(): void {
    if (!editor) return;
    services().openSheetAssetPicker({
      currentAssetId: editor.assetId,
      select(assetId) {
        if (!editor) return;
        editor.assetId = assetId;
        rerender();
      },
    });
  }

  function saveEditor(): void {
    if (!editor) return;
    const state = editor;
    if (state.collection === 'abilities') {
      const item = {
        imageAssetId: state.assetId,
        name: state.values.name ?? '',
        source: state.values.source ?? '',
        type: state.values.type ?? '',
        timing: state.values.timing ?? '',
        cost: state.values.cost ?? '',
        range: state.values.range ?? '',
        effect: state.values.effect ?? '',
      };
      if (state.id) send('sheet:nechronica:update', { collection: 'abilities', id: state.id, changes: item });
      else send('sheet:nechronica:create', { collection: 'abilities', item });
    } else if (state.collection === 'body') {
      const item = {
        imageAssetId: state.assetId,
        name: state.values.name ?? '',
        timing: state.values.timing ?? '',
        cost: state.values.cost ?? '',
        range: state.values.range ?? '',
        effect: state.values.effect ?? '',
      };
      if (state.id) send('sheet:nechronica:update', { collection: 'body', zone: state.zone, id: state.id, changes: item });
      else send('sheet:nechronica:create', { collection: 'body', zone: state.zone, item });
    } else if (state.collection === 'fetters') {
      const item = {
        imageAssetId: state.assetId,
        target: state.values.target ?? '',
        fetter: state.values.fetter ?? '',
        madness: state.values.madness ?? '',
        description: state.values.description ?? '',
      };
      if (state.id) send('sheet:nechronica:update', { collection: 'fetters', id: state.id, changes: item });
      else send('sheet:nechronica:create', { collection: 'fetters', item });
    } else {
      const item = {
        name: state.values.name ?? '',
        number: Number(state.values.number || 0),
        content: state.values.content ?? '',
      };
      if (state.id) send('sheet:nechronica:update', { collection: 'memories', id: state.id, changes: item });
      else send('sheet:nechronica:create', { collection: 'memories', item });
    }
    editor = undefined;
    rerender();
  }

  function editorTitle(): string {
    if (!editor) return '';
    const base = editor.collection === 'abilities' ? 'способности'
      : editor.collection === 'body' ? 'части тела'
        : editor.collection === 'fetters' ? 'узы' : 'воспоминания';
    return editor.id ? `Редактирование ${base}` : `Новая запись: ${base}`;
  }

  function renderEditor(): HTMLElement | undefined {
    if (!editor) return undefined;
    const section = sheetSection(editorTitle(), 'nechronica-editor');
    const assetRow = el('div', 'nechronica-editor-asset');
    assetRow.append(makeSheetPortrait(editor.assetId, editor.values.name || 'Изображение', 'nechronica-editor-thumb', services().assetUrl));
    const assetButton = el('button', 'secondary', editor.assetId ? 'Сменить изображение' : 'Выбрать изображение');
    assetButton.type = 'button';
    assetButton.addEventListener('click', pickAsset);
    assetRow.append(assetButton);
    if (editor.assetId) {
      const clear = el('button', 'secondary danger-text', 'Убрать');
      clear.type = 'button';
      clear.addEventListener('click', () => { if (editor) { editor.assetId = null; rerender(); } });
      assetRow.append(clear);
    }
    section.append(assetRow);

    const fields = el('div', 'nechronica-editor-fields');
    const values = editor.values;
    if (editor.collection === 'abilities') {
      fields.append(
        labeled('Название', textInput(values.name ?? '', 120, (value) => { values.name = value; })),
        labeled('Источник', textInput(values.source ?? '', 120, (value) => { values.source = value; })),
        labeled('Тип', textInput(values.type ?? '', 80, (value) => { values.type = value; })),
        labeled('Тайминг', textInput(values.timing ?? '', 80, (value) => { values.timing = value; })),
        labeled('Цена', textInput(values.cost ?? '', 80, (value) => { values.cost = value; })),
        labeled('Дистанция', textInput(values.range ?? '', 80, (value) => { values.range = value; })),
        labeled('Эффект', textArea(values.effect ?? '', 8000, 5, (value) => { values.effect = value; })),
      );
    } else if (editor.collection === 'body') {
      fields.append(
        labeled('Название', textInput(values.name ?? '', 120, (value) => { values.name = value; })),
        labeled('Тайминг', textInput(values.timing ?? '', 80, (value) => { values.timing = value; })),
        labeled('Цена', textInput(values.cost ?? '', 80, (value) => { values.cost = value; })),
        labeled('Дистанция', textInput(values.range ?? '', 80, (value) => { values.range = value; })),
        labeled('Эффект', textArea(values.effect ?? '', 8000, 5, (value) => { values.effect = value; })),
      );
    } else if (editor.collection === 'fetters') {
      fields.append(
        labeled('Имя / Цель', textInput(values.target ?? '', 120, (value) => { values.target = value; })),
        labeled('Уза', textInput(values.fetter ?? '', 120, (value) => { values.fetter = value; })),
        labeled('Безумие', textInput(values.madness ?? '', 120, (value) => { values.madness = value; })),
        labeled('Описание', textArea(values.description ?? '', 8000, 5, (value) => { values.description = value; })),
      );
    } else {
      fields.append(
        labeled('Название', textInput(values.name ?? '', 120, (value) => { values.name = value; })),
        labeled('Номер', textInput(values.number ?? '0', 12, (value) => { values.number = value.replace(/[^0-9]/g, ''); })),
        labeled('Описание', textArea(values.content ?? '', 8000, 5, (value) => { values.content = value; })),
      );
    }
    section.append(fields);

    const actions = el('div', 'nechronica-editor-actions');
    const save = el('button', '', 'Сохранить');
    save.type = 'button';
    save.addEventListener('click', saveEditor);
    const cancel = el('button', 'secondary', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => { editor = undefined; rerender(); });
    actions.append(save, cancel);
    section.append(actions);
    return section;
  }

  function moveItem(collection: Collection, zone: NechronicaBodyZone | undefined, id: string, direction: -1 | 1): void {
    if (!currentSheet) return;
    const data = parseNechronicaSheetData(currentSheet.systemData);
    const ids = collection === 'body' && zone ? data.bodyParts[zone].map((entry) => entry.id)
      : collection === 'abilities' ? data.abilities.map((entry) => entry.id)
        : collection === 'fetters' ? data.fetters.map((entry) => entry.id)
          : data.memories.map((entry) => entry.id);
    const index = ids.indexOf(id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    const next = [...ids];
    [next[index], next[target]] = [next[target]!, next[index]!];
    send('sheet:nechronica:reorder', { collection, ...(zone ? { zone } : {}), ids: next });
  }

  function rowActions(
    collection: Collection,
    zone: NechronicaBodyZone | undefined,
    id: string,
    index: number,
    total: number,
    item: NechronicaAbility | NechronicaBodyPart | NechronicaFetter | NechronicaMemory,
  ): HTMLElement {
    const actions = el('div', 'nechronica-row-actions');
    if (!currentOptions?.editing) return actions;
    if (index > 0) actions.append(makeRowButton('↑', 'Переместить выше', () => moveItem(collection, zone, id, -1)));
    if (index < total - 1) actions.append(makeRowButton('↓', 'Переместить ниже', () => moveItem(collection, zone, id, 1)));
    actions.append(makeRowButton('✎', 'Изменить', () => openEditor(collection, zone, item)));
    actions.append(makeRowButton('×', 'Удалить', () => {
      send('sheet:nechronica:delete', { collection, ...(zone ? { zone } : {}), id });
    }, true));
    return actions;
  }

  function header(sheet: CharacterSheet, data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const headerNode = el('section', 'nechronica-header');
    const portrait = el('div', 'nechronica-portrait-block');
    portrait.append(makeSheetPortrait(sheet.portraitAssetId, sheet.characterName || 'Персонаж', 'nechronica-portrait', services().assetUrl));
    if (options.editing) {
      const pick = el('button', 'secondary nechronica-portrait-button', 'Портрет');
      pick.type = 'button';
      pick.addEventListener('click', () => services().openSheetAssetPicker({
        currentAssetId: sheet.portraitAssetId,
        select(assetId) { void services().command('sheet:update', { id: sheet.id, changes: { portraitAssetId: assetId } }); },
      }));
      portrait.append(pick);
    }
    headerNode.append(portrait);

    const identity = el('div', 'nechronica-identity');
    if (options.editing) {
      const nameInput = textInput(sheet.characterName, 80, () => undefined);
      nameInput.className = 'nechronica-name-input';
      nameInput.placeholder = 'Без имени';
      nameInput.addEventListener('change', () => {
        void services().command('sheet:update', { id: sheet.id, changes: { characterName: nameInput.value } });
      });
      identity.append(nameInput);
    } else {
      identity.append(el('h2', 'nechronica-name', sheet.characterName || 'Без имени'));
    }

    const stats = el('div', 'nechronica-stats');
    const apValue = (label: string, value: number, key: 'maxAp' | 'currentAp'): HTMLElement => {
      const box = el('div', 'nechronica-stat');
      box.append(el('span', 'nechronica-stat-label', label));
      if (options.canEdit) box.append(makeStepper(value, 0, 1_000_000_000, label, (next) => send('sheet:nechronica:ap', { [key]: next })));
      else box.append(el('strong', 'nechronica-stat-value', String(value)));
      return box;
    };
    stats.append(apValue('Maximum AP', data.profile.maxAp, 'maxAp'), apValue('Current AP', data.profile.currentAp, 'currentAp'));

    const deployment = el('div', 'nechronica-stat');
    deployment.append(el('span', 'nechronica-stat-label', 'Deployment'));
    if (options.editing) {
      const select = el('select');
      const none = el('option', '', 'Не указано'); none.value = '';
      select.append(none);
      for (const value of ['eden', 'elysium', 'limbo'] as const) {
        const option = el('option', '', DEPLOYMENT_LABELS[value]); option.value = value; select.append(option);
      }
      select.value = data.profile.deployment ?? '';
      select.addEventListener('change', () => {
        send('sheet:nechronica:profile', { deployment: select.value || null });
      });
      deployment.append(select);
    } else {
      deployment.append(el('strong', 'nechronica-stat-value', data.profile.deployment ? DEPLOYMENT_LABELS[data.profile.deployment] : '—'));
    }
    stats.append(deployment);

    const favor = el('div', 'nechronica-stat');
    favor.append(el('span', 'nechronica-stat-label', 'Одобрение (Favor)'));
    if (options.editing) {
      favor.append(makeStepper(data.profile.approval, 0, 1_000_000_000, 'Одобрение', (next) => send('sheet:nechronica:profile', { approval: next })));
    } else {
      favor.append(el('strong', 'nechronica-stat-value', String(data.profile.approval)));
    }
    stats.append(favor);

    identity.append(stats);
    headerNode.append(identity);
    return headerNode;
  }

  function renderTabs(): HTMLElement {
    const nav = el('nav', 'nechronica-tabs');
    nav.setAttribute('aria-label', 'Разделы листа Nechronica');
    for (const tab of TAB_LABELS) {
      const button = el('button', 'nechronica-tab', tab);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(tab === activeTab));
      button.classList.toggle('active', tab === activeTab);
      button.addEventListener('click', () => { activeTab = tab; editor = undefined; rerender(); });
      nav.append(button);
    }
    return nav;
  }

  function toolbar(createLabel: string | undefined, onCreate: (() => void) | undefined, extra: HTMLElement[] = []): HTMLElement {
    const bar = el('div', 'nechronica-toolbar');
    if (currentOptions?.editing && createLabel && onCreate) {
      const create = el('button', '', createLabel);
      create.type = 'button';
      create.addEventListener('click', onCreate);
      bar.append(create);
    }
    for (const node of extra) bar.append(node);
    return bar;
  }

  function resetUsedButton(collection: 'abilities' | 'body', zone?: NechronicaBodyZone): HTMLElement | undefined {
    if (!currentOptions?.canEdit) return undefined;
    const button = el('button', 'secondary', zone ? `Сбросить Used: ${ZONE_LABELS[zone]}` : 'Сбросить Used');
    button.type = 'button';
    button.addEventListener('click', () => send('sheet:nechronica:reset-used', { collection, ...(zone ? { zone } : {}) }));
    return button;
  }

  function referenceButton(text: string, kind: 'ability' | 'body' | 'fetter', id: string, zone?: NechronicaBodyZone): HTMLButtonElement {
    const button = el('button', 'nechronica-reference-link', text || 'Без названия');
    button.type = 'button';
    button.title = 'Отправить карточку в общую историю';
    button.addEventListener('click', () => send('sheet:nechronica:reference', { kind, id, ...(zone ? { zone } : {}) }));
    return button;
  }

  function tableShell(headers: string[]): { wrapper: HTMLElement; body: HTMLTableSectionElement } {
    const wrapper = el('div', 'nechronica-table-wrap');
    const table = el('table', 'nechronica-table');
    const thead = el('thead');
    const headRow = el('tr');
    for (const headerText of headers) headRow.append(el('th', '', headerText));
    thead.append(headRow);
    const body = el('tbody');
    table.append(thead, body);
    wrapper.append(table);
    return { wrapper, body };
  }

  function imageCell(assetId: string | null): HTMLTableCellElement {
    const cell = el('td', 'nechronica-image-cell');
    cell.append(makeSheetPortrait(assetId, 'Изображение', 'nechronica-row-thumb', services().assetUrl));
    return cell;
  }

  function usedCheckbox(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLInputElement {
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.disabled = !currentOptions?.canEdit;
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => onChange(input.checked));
    return input;
  }

  function renderAbilities(data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const section = sheetSection('Способности', 'nechronica-abilities');
    const reset = resetUsedButton('abilities');
    section.append(toolbar(options.editing ? 'Добавить способность' : undefined, () => openEditor('abilities'), reset ? [reset] : []));
    const editorNode = renderEditor();
    if (editorNode && editor?.collection === 'abilities') section.append(editorNode);
    if (!data.abilities.length) {
      section.append(el('p', 'panel-note', 'Способностей пока нет.'));
      return section;
    }
    const { wrapper, body } = tableShell(['', 'Название', 'Источник', 'Тип', 'Тайминг', 'Цена', 'Дистанция', 'Эффект', 'Used', '']);
    data.abilities.forEach((ability, index) => {
      const row = el('tr');
      row.append(imageCell(ability.imageAssetId));
      const nameCell = el('td', 'nechronica-name-cell');
      nameCell.append(referenceButton(ability.name, 'ability', ability.id));
      row.append(nameCell);
      row.append(el('td', '', ability.source || '—'));
      row.append(el('td', '', ability.type || '—'));
      row.append(el('td', '', ability.timing || '—'));
      row.append(el('td', '', ability.cost || '—'));
      row.append(el('td', '', ability.range || '—'));
      const effect = el('td', 'nechronica-effect-cell');
      effect.append(effectCell(ability.effect, itemKey('abilities', ability.id)));
      row.append(effect);
      const used = el('td', 'nechronica-check-cell');
      used.append(usedCheckbox(ability.used, `Used: ${ability.name}`, (checked) => send('sheet:nechronica:used', { collection: 'abilities', id: ability.id, used: checked })));
      row.append(used);
      const actions = el('td', 'nechronica-actions-cell');
      actions.append(rowActions('abilities', undefined, ability.id, index, data.abilities.length, ability));
      row.append(actions);
      body.append(row);
    });
    section.append(wrapper);
    return section;
  }

  function renderBody(data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const section = sheetSection('Тело', 'nechronica-body');
    section.append(toolbar(undefined, undefined, resetUsedButton('body') ? [resetUsedButton('body')!] : []));
    for (const zone of ZONES) {
      const zoneSection = el('section', 'nechronica-zone');
      zoneSection.append(el('h4', 'nechronica-zone-title', ZONE_LABELS[zone]));
      const reset = resetUsedButton('body', zone);
      zoneSection.append(toolbar(options.editing ? 'Добавить' : undefined, () => openEditor('body', zone), reset ? [reset] : []));
      if (editor && editor.collection === 'body' && editor.zone === zone) {
        const editorNode = renderEditor();
        if (editorNode) zoneSection.append(editorNode);
      }
      const parts = data.bodyParts[zone];
      if (!parts.length) {
        zoneSection.append(el('p', 'panel-note', 'Пусто.'));
      } else {
        const { wrapper, body } = tableShell(['', 'Название', 'Тайминг', 'Цена', 'Дистанция', 'Эффект', 'Used', 'Destroyed', '']);
        parts.forEach((part, index) => {
          const row = el('tr', part.destroyed ? 'is-destroyed' : undefined);
          row.append(imageCell(part.imageAssetId));
          const nameCell = el('td', 'nechronica-name-cell');
          nameCell.append(referenceButton(part.name, 'body', part.id, zone));
          row.append(nameCell);
          row.append(el('td', '', part.timing || '—'));
          row.append(el('td', '', part.cost || '—'));
          row.append(el('td', '', part.range || '—'));
          const effect = el('td', 'nechronica-effect-cell');
          effect.append(effectCell(part.effect, itemKey('body', part.id, zone)));
          row.append(effect);
          const used = el('td', 'nechronica-check-cell');
          used.append(usedCheckbox(part.used, `Used: ${part.name}`, (checked) => send('sheet:nechronica:used', { collection: 'body', zone, id: part.id, used: checked })));
          row.append(used);
          const destroyed = el('td', 'nechronica-check-cell');
          destroyed.append(usedCheckbox(part.destroyed, `Destroyed: ${part.name}`, (checked) => send('sheet:nechronica:destroyed', { zone, id: part.id, destroyed: checked })));
          row.append(destroyed);
          const actions = el('td', 'nechronica-actions-cell');
          actions.append(rowActions('body', zone, part.id, index, parts.length, part));
          row.append(actions);
          body.append(row);
        });
        zoneSection.append(wrapper);
      }
      section.append(zoneSection);
    }
    return section;
  }

  function renderFetters(data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const section = sheetSection('Узы и безумие', 'nechronica-fetters');
    section.append(toolbar(options.editing ? 'Добавить узу' : undefined, () => openEditor('fetters')));
    const editorNode = renderEditor();
    if (editorNode && editor?.collection === 'fetters') section.append(editorNode);
    if (!data.fetters.length) {
      section.append(el('p', 'panel-note', 'Уз пока нет.'));
      return section;
    }
    const { wrapper, body } = tableShell(['', 'Имя / Цель', 'Уза', 'Безумие', 'Описание', 'Очки безумия', '']);
    data.fetters.forEach((fetter, index) => {
      const broken = isBrokenHeart(fetter);
      const row = el('tr', broken ? 'is-broken-heart' : undefined);
      row.append(imageCell(fetter.imageAssetId));
      const nameCell = el('td', 'nechronica-name-cell');
      nameCell.append(referenceButton(fetter.target || fetter.fetter, 'fetter', fetter.id));
      row.append(nameCell);
      row.append(el('td', '', fetter.fetter || '—'));
      row.append(el('td', '', fetter.madness || '—'));
      const description = el('td', 'nechronica-effect-cell');
      description.append(effectCell(fetter.description, itemKey('fetters', fetter.id)));
      row.append(description);
      const boxes = el('td', 'nechronica-madness-cell');
      fetter.spentMadness.forEach((checked, boxIndex) => {
        const input = usedCheckbox(checked, `Очко безумия ${boxIndex + 1}: ${fetter.target || fetter.fetter}`, (next) => send('sheet:nechronica:madness', { id: fetter.id, index: boxIndex, checked: next }));
        input.classList.add('nechronica-madness-box');
        boxes.append(input);
      });
      row.append(boxes);
      const actions = el('td', 'nechronica-actions-cell');
      actions.append(rowActions('fetters', undefined, fetter.id, index, data.fetters.length, fetter));
      row.append(actions);
      body.append(row);
    });
    section.append(wrapper);
    return section;
  }

  function renderInfo(data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const section = sheetSection('Инфо', 'nechronica-info');
    const notesButton = el('button', 'secondary', 'Открыть заметки персонажа');
    notesButton.type = 'button';
    notesButton.addEventListener('click', () => services().openPersonalNotes());
    section.append(toolbar(undefined, undefined, [notesButton]));

    if (options.editing) {
      const fields = el('div', 'nechronica-info-fields');
      const values: Record<string, string> = {
        position: data.info.position,
        mainClass: data.info.mainClass,
        secondaryClass: data.info.secondaryClass,
        premonition: data.info.premonition,
        armaments: String(data.info.armaments),
        mutations: String(data.info.mutations),
        enhancements: String(data.info.enhancements),
        notes: data.info.notes,
      };
      const update = (key: string, value: string) => { values[key] = value; };
      fields.append(
        labeled('Позиция', textInput(values.position, 120, (value) => update('position', value))),
        labeled('Основной класс', textInput(values.mainClass, 120, (value) => update('mainClass', value))),
        labeled('Побочный класс', textInput(values.secondaryClass, 120, (value) => update('secondaryClass', value))),
        labeled('Предчувствие', textArea(values.premonition, 2000, 3, (value) => update('premonition', value))),
        labeled('Вооружение', textInput(values.armaments, 12, (value) => update('armaments', value.replace(/[^0-9]/g, '')))),
        labeled('Мутации', textInput(values.mutations, 12, (value) => update('mutations', value.replace(/[^0-9]/g, '')))),
        labeled('Улучшения', textInput(values.enhancements, 12, (value) => update('enhancements', value.replace(/[^0-9]/g, '')))),
        labeled('Заметки персонажа', textArea(values.notes, 20000, 6, (value) => update('notes', value))),
      );
      const save = el('button', '', 'Сохранить');
      save.type = 'button';
      save.addEventListener('click', () => send('sheet:nechronica:info', {
        changes: {
          position: values.position,
          mainClass: values.mainClass,
          secondaryClass: values.secondaryClass,
          premonition: values.premonition,
          armaments: Number(values.armaments || 0),
          mutations: Number(values.mutations || 0),
          enhancements: Number(values.enhancements || 0),
          notes: values.notes,
        },
      }));
      fields.append(save);
      section.append(fields);
      return section;
    }

    const list = el('dl', 'nechronica-info-list');
    const rows: Array<[string, string]> = [
      ['Позиция', data.info.position || '—'],
      ['Основной класс', data.info.mainClass || '—'],
      ['Побочный класс', data.info.secondaryClass || '—'],
      ['Предчувствие', data.info.premonition || '—'],
      ['Вооружение', String(data.info.armaments)],
      ['Мутации', String(data.info.mutations)],
      ['Улучшения', String(data.info.enhancements)],
      ['Заметки персонажа', data.info.notes || '—'],
    ];
    for (const [labelText, value] of rows) {
      list.append(el('dt', '', labelText), el('dd', '', value));
    }
    section.append(list);
    return section;
  }

  function renderMemories(data: NechronicaSheetData, options: SystemSheetRenderOptions): HTMLElement {
    const section = sheetSection('Память', 'nechronica-memories');
    section.append(toolbar(options.editing ? 'Добавить воспоминание' : undefined, () => openEditor('memories')));
    const editorNode = renderEditor();
    if (editorNode && editor?.collection === 'memories') section.append(editorNode);
    if (!data.memories.length) {
      section.append(el('p', 'panel-note', 'Воспоминаний пока нет.'));
      return section;
    }
    const list = el('ul', 'nechronica-memory-list');
    data.memories.forEach((memory, index) => {
      const item = el('li', 'nechronica-memory');
      const heading = el('div', 'nechronica-memory-heading');
      heading.append(el('span', 'nechronica-memory-number', String(memory.number)), el('h4', '', memory.name || 'Без названия'));
      item.append(heading);
      item.append(effectCell(memory.content, itemKey('memories', memory.id)));
      item.append(rowActions('memories', undefined, memory.id, index, data.memories.length, memory));
      list.append(item);
    });
    section.append(list);
    return section;
  }

  return {
    ownsProfile: true,

    mount(nextContext) {
      context = nextContext;
      controls = el('section', 'dice-roll-controls');
      controls.setAttribute('aria-label', 'Броски Nechronica');
      controls.append(el('h3', '', 'Броски Nechronica'), el('p', 'panel-note', 'Система бросков Nechronica — находится в разработке.'));
      nextContext.elements.rollControlsHome.append(controls);
    },

    dispose() {
      controls?.remove();
      controls = undefined;
      context = undefined;
      currentSheet = undefined;
      currentOptions = undefined;
      editor = undefined;
      expandedEffects.clear();
    },

    renderRollControls() {
      /* The placeholder needs no dynamic state. */
    },

    renderSheet(sheet, options) {
      if (!context) return;
      if (currentSheet?.id !== sheet.id) {
        editor = undefined;
        expandedEffects.clear();
      }
      currentSheet = sheet;
      currentOptions = options;
      const container = context.elements.sheet;
      let data: NechronicaSheetData;
      try {
        data = parseNechronicaSheetData(sheet.systemData);
      } catch (error) {
        container.replaceChildren();
        const section = sheetSection('Лист персонажа', 'sheet-schema-error');
        const note = el('p', 'panel-note error-text');
        note.textContent = error instanceof NechronicaSheetSchemaError
          ? error.message
          : `Не удалось открыть лист: ${error instanceof Error ? error.message : 'неизвестная ошибка'}.`;
        const hint = el('p', 'panel-note');
        hint.textContent = 'Лист не изменён. Повторите контролируемую миграцию листа после обновления сборки.';
        section.append(note, hint);
        container.append(section);
        return;
      }
      container.replaceChildren();
      container.append(header(sheet, data, options), renderTabs());
      const body = el('div', 'nechronica-tab-body');
      if (activeTab === 'Способности') body.append(renderAbilities(data, options));
      else if (activeTab === 'Тело') body.append(renderBody(data, options));
      else if (activeTab === 'Узы и безумие') body.append(renderFetters(data, options));
      else if (activeTab === 'Инфо') body.append(renderInfo(data, options));
      else body.append(renderMemories(data, options));
      container.append(body);
    },
  };
}
