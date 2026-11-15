import type { CharacterSheet, CharacterSheetAbility } from '../../../shared/board.js';
import { BOARD_FONT_OPTIONS } from '../../../shared/fonts.js';
import { formatSigned, readCollapsedAbilities, setAbilityCollapsed } from '../../../shared/sheet-ui.js';
import type { SystemClientContext, SystemClientModule, SystemSheetRenderOptions } from '../../client-contract.js';
import { makeRowButton, makeSheetPortrait, makeStepper, moveIds, sheetSection } from '../../../client/sheet-dom.js';
import { pbtaSheetSchema } from './schema.js';

/**
 * PbtA client implementation.
 *
 * The factory creates a per-room instance: all mutable UI state and DOM
 * references live in this closure, never at module scope. The dynamic chunk is
 * shared by all PbtA rooms, but the mounted interface is not.
 */
export function createClientModule(): SystemClientModule {
  let context: SystemClientContext | undefined;
  let controls: HTMLElement | undefined;
  let actorSelect: HTMLSelectElement | undefined;
  let actorRow: HTMLElement | undefined;
  let bonusInput: HTMLInputElement | undefined;
  let ownedSheetNodes: HTMLElement[] = [];

  const removeSheetNodes = (): void => {
    for (const node of ownedSheetNodes) node.remove();
    ownedSheetNodes = [];
  };

  const appendSheetNode = (node: HTMLElement): void => {
    ownedSheetNodes.push(node);
    context!.elements.sheet.append(node);
  };

  const buildRollControls = (): HTMLElement => {
    const section = document.createElement('section');
    section.className = 'dice-roll-controls';
    section.setAttribute('aria-label', 'Проверка PbtA');
    const heading = document.createElement('h3');
    heading.textContent = 'Проверка PbtA';

    const bonusLabel = document.createElement('label');
    bonusLabel.textContent = 'Бонус характеристики';
    const bonus = document.createElement('input');
    bonus.type = 'number';
    bonus.min = '-1000';
    bonus.max = '1000';
    bonus.value = '0';
    bonus.className = 'pbta-bonus';
    bonusInput = bonus;

    const modifierLabel = document.createElement('label');
    modifierLabel.textContent = 'Ситуационный модификатор';
    const modifier = document.createElement('select');
    modifier.className = 'pbta-modifier';
    for (const [value, label] of [['0', 'Без модификатора'], ['1', 'Превосходство (+1)'], ['-1', 'Угнетение (-1)']] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      modifier.append(option);
    }

    const disadvantageLabel = document.createElement('label');
    disadvantageLabel.className = 'dice-checkbox';
    const disadvantage = document.createElement('input');
    disadvantage.type = 'checkbox';
    disadvantage.className = 'pbta-disadvantage';
    disadvantageLabel.append(disadvantage, document.createTextNode(' Помеха'));

    actorRow = document.createElement('label');
    actorRow.className = 'pbta-actor-row';
    actorRow.textContent = 'Бросок за игрока';
    const actor = document.createElement('select');
    actor.className = 'pbta-actor';
    actorSelect = actor;
    actorRow.append(actor);

    const roll = document.createElement('button');
    roll.type = 'button';
    roll.textContent = 'Бросить 2d6';

    bonus.addEventListener('input', () => {
      const pending = context?.services.getPendingRoll();
      if (pending && Number(bonus.value) !== pending.characteristicBonus) context?.services.clearPendingRoll();
    });
    actor.addEventListener('change', () => {
      const pending = context?.services.getPendingRoll();
      const identity = context?.services.getIdentity();
      if (pending && identity?.role === 'gm' && actor.value !== pending.characterOwnerId) context?.services.clearPendingRoll();
    });
    roll.addEventListener('click', () => {
      if (!context) return;
      const identity = context.services.getIdentity();
      const characteristicBonus = Number(bonus.value);
      const situationalModifier = Number(modifier.value);
      const isDisadvantage = disadvantage.checked;
      const actorId = identity.role === 'gm' ? actor.value : undefined;
      let pending = context.services.getPendingRoll();
      if (pending && (characteristicBonus !== pending.characteristicBonus
        || (identity.role === 'gm' ? actorId !== pending.characterOwnerId : pending.characterOwnerId !== identity.participantId))) {
        context.services.clearPendingRoll();
        pending = undefined;
      }
      void context.services.command('dice:pbta', {
        characteristicBonus,
        situationalModifier,
        disadvantage: isDisadvantage,
        ...(actorId ? { actorId } : {}),
        ...(pending ? {
          characteristicName: pending.characteristicName,
          characterId: pending.characterId,
          characterOwnerId: pending.characterOwnerId,
        } : {}),
      });
    });

    section.append(
      heading, bonusLabel, bonus, modifierLabel, modifier, disadvantageLabel, actorRow, roll,
    );
    return section;
  };

  const refreshActorOptions = (): void => {
    if (!context || !actorSelect || !actorRow) return;
    const identity = context.services.getIdentity();
    const state = context.services.getState();
    const previous = actorSelect.value;
    actorSelect.replaceChildren(...state.participants
      .filter((participant) => participant.role === 'player')
      .map((participant) => {
        const option = document.createElement('option');
        option.value = participant.participantId;
        option.textContent = participant.name;
        return option;
      }));
    if (state.participants.some((participant) => participant.participantId === previous && participant.role === 'player')) {
      actorSelect.value = previous;
    }
    const gm = identity.role === 'gm';
    actorRow.hidden = !gm;
    actorSelect.hidden = !gm;
  };

  const renderAbility = (
    sheet: CharacterSheet,
    ability: CharacterSheetAbility,
    options: SystemSheetRenderOptions,
    collapsed: boolean,
  ): HTMLElement => {
    const services = context!.services;
    const card = document.createElement('article');
    card.className = 'sheet-ability';
    const header = document.createElement('div');
    header.className = 'sheet-ability-header';
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'sheet-ability-expand';
    expand.textContent = collapsed ? '▸' : '▾';
    expand.setAttribute('aria-expanded', String(!collapsed));
    expand.setAttribute('aria-label', collapsed ? 'Развернуть способность' : 'Свернуть способность');
    expand.addEventListener('click', () => {
      const identity = services.getIdentity();
      setAbilityCollapsed(localStorage, services.storageScope(), identity.participantId, sheet.id, ability.id, !collapsed);
      services.renderSheet();
    });
    const image = makeSheetPortrait(ability.assetId, ability.name, 'sheet-ability-image', services.assetUrl);
    const title = document.createElement('strong');
    title.className = 'sheet-ability-name';
    title.textContent = ability.name || 'Без названия';
    services.applyFont(title, ability.fontFamily);
    header.append(expand, image, title);
    if (collapsed && ability.counterEnabled) {
      const summary = document.createElement('span');
      summary.className = 'sheet-ability-summary';
      summary.textContent = `${ability.counterName || 'Счётчик'}: ${ability.counterValue}`;
      header.append(summary);
    }
    if (collapsed && ability.checkboxEnabled && ability.checked) {
      const summary = document.createElement('span');
      summary.className = 'sheet-ability-summary';
      summary.textContent = ability.checkboxLabel || 'Отмечено';
      header.append(summary);
    }
    if (options.canEdit) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'secondary sheet-ability-apply';
      apply.textContent = 'Применить';
      apply.title = 'Добавить событие применения способности в историю';
      apply.addEventListener('click', () => {
        apply.disabled = true;
        void services.command('sheet:ability:apply', { sheetId: sheet.id, id: ability.id })
          .finally(() => { apply.disabled = false; });
      });
      header.append(apply);
    }
    card.append(header);
    if (collapsed) return card;

    const body = document.createElement('div');
    body.className = 'sheet-ability-body';
    const description = document.createElement('div');
    description.className = 'sheet-ability-description';
    description.textContent = ability.description || 'Описание не задано.';
    services.applyFont(description, ability.fontFamily);
    body.append(description);

    if (ability.counterEnabled) {
      const counter = document.createElement('div');
      counter.className = 'sheet-resource sheet-ability-resource';
      const label = document.createElement('strong');
      label.textContent = ability.counterName || 'Счётчик';
      counter.append(label);
      if (options.canEdit) {
        counter.append(makeStepper(ability.counterValue, -1_000_000_000, 1_000_000_000, ability.counterName || 'Счётчик способности', (value) => {
          if (options.editing) void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { counterValue: value } });
          else void services.command('sheet:ability:value', { sheetId: sheet.id, id: ability.id, counterValue: value });
        }));
      } else {
        const value = document.createElement('span');
        value.className = 'sheet-resource-value';
        value.textContent = String(ability.counterValue);
        counter.append(value);
      }
      body.append(counter);
    }

    if (ability.checkboxEnabled) {
      const checkLabel = document.createElement('label');
      checkLabel.className = 'sheet-ability-check';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ability.checked;
      checkbox.disabled = !options.canEdit;
      checkbox.addEventListener('change', () => {
        if (options.editing) void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checked: checkbox.checked } });
        else void services.command('sheet:ability:value', { sheetId: sheet.id, id: ability.id, checked: checkbox.checked });
      });
      checkLabel.append(checkbox, document.createTextNode(ability.checkboxLabel || 'Отметка'));
      body.append(checkLabel);
    }

    if (options.editing) {
      const editor = document.createElement('div');
      editor.className = 'sheet-ability-editor';
      const nameLabel = document.createElement('label');
      nameLabel.textContent = 'Название';
      const name = document.createElement('input');
      name.value = ability.name;
      name.maxLength = 80;
      name.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { name: name.value } }));
      nameLabel.append(name);
      const descriptionLabel = document.createElement('label');
      descriptionLabel.textContent = 'Описание';
      const descriptionInput = document.createElement('textarea');
      descriptionInput.rows = 5;
      descriptionInput.maxLength = 8000;
      descriptionInput.value = ability.description;
      descriptionInput.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { description: descriptionInput.value } }));
      descriptionLabel.append(descriptionInput);
      const fontLabel = document.createElement('label');
      fontLabel.textContent = 'Шрифт';
      const fontSelect = document.createElement('select');
      for (const font of BOARD_FONT_OPTIONS) {
        const option = document.createElement('option');
        option.value = font.value;
        option.textContent = font.label;
        fontSelect.append(option);
      }
      fontSelect.value = ability.fontFamily || 'default';
      fontSelect.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { fontFamily: fontSelect.value } }));
      fontLabel.append(fontSelect);
      editor.append(nameLabel, descriptionLabel, fontLabel);

      const imageRow = document.createElement('div');
      imageRow.className = 'sheet-portrait-actions';
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'secondary';
      pick.textContent = 'Выбрать картинку';
      pick.addEventListener('click', () => services.openAbilityAssetPicker(ability.id, ability.assetId));
      imageRow.append(pick);
      if (ability.assetId) {
        const clear = document.createElement('button');
        clear.type = 'button';
        clear.className = 'secondary danger-text';
        clear.textContent = 'Убрать картинку';
        clear.addEventListener('click', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { assetId: null } }));
        imageRow.append(clear);
      }
      editor.append(imageRow);

      const counterToggle = document.createElement('label');
      counterToggle.className = 'sheet-inline-check';
      const counterEnabled = document.createElement('input');
      counterEnabled.type = 'checkbox';
      counterEnabled.checked = ability.counterEnabled;
      counterEnabled.addEventListener('change', () => {
        const next = counterEnabled.checked;
        void services.command('sheet:ability:update', {
          sheetId: sheet.id,
          id: ability.id,
          changes: { counterEnabled: next, ...(next && !ability.counterName ? { counterName: 'Заряды' } : {}) },
        });
      });
      counterToggle.append(counterEnabled, document.createTextNode(' Числовой счётчик'));
      editor.append(counterToggle);
      if (ability.counterEnabled) {
        const counterNameLabel = document.createElement('label');
        counterNameLabel.textContent = 'Название счётчика';
        const counterName = document.createElement('input');
        counterName.value = ability.counterName;
        counterName.maxLength = 80;
        counterName.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { counterName: counterName.value } }));
        counterNameLabel.append(counterName);
        editor.append(counterNameLabel);
      }

      const checkboxToggle = document.createElement('label');
      checkboxToggle.className = 'sheet-inline-check';
      const checkboxEnabled = document.createElement('input');
      checkboxEnabled.type = 'checkbox';
      checkboxEnabled.checked = ability.checkboxEnabled;
      checkboxEnabled.addEventListener('change', () => {
        const next = checkboxEnabled.checked;
        void services.command('sheet:ability:update', {
          sheetId: sheet.id,
          id: ability.id,
          changes: { checkboxEnabled: next, ...(next && !ability.checkboxLabel ? { checkboxLabel: 'Использовано' } : {}) },
        });
      });
      checkboxToggle.append(checkboxEnabled, document.createTextNode(' Чекбокс'));
      editor.append(checkboxToggle);
      if (ability.checkboxEnabled) {
        const checkboxLabel = document.createElement('label');
        checkboxLabel.textContent = 'Подпись чекбокса';
        const checkboxText = document.createElement('input');
        checkboxText.value = ability.checkboxLabel;
        checkboxText.maxLength = 80;
        checkboxText.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checkboxLabel: checkboxText.value } }));
        checkboxLabel.append(checkboxText);
        const checkedLabel = document.createElement('label');
        checkedLabel.className = 'sheet-inline-check';
        const checked = document.createElement('input');
        checked.type = 'checkbox';
        checked.checked = ability.checked;
        checked.addEventListener('change', () => void services.command('sheet:ability:update', { sheetId: sheet.id, id: ability.id, changes: { checked: checked.checked } }));
        checkedLabel.append(checked, document.createTextNode(' Отмечено'));
        editor.append(checkboxLabel, checkedLabel);
      }

      const tools = document.createElement('div');
      tools.className = 'sheet-row-tools';
      tools.append(
        makeRowButton('↑', 'Переместить выше', () => {
          const ids = moveIds(sheet.abilities, ability.id, -1);
          if (ids) void services.command('sheet:ability:reorder', { sheetId: sheet.id, ids });
        }),
        makeRowButton('↓', 'Переместить ниже', () => {
          const ids = moveIds(sheet.abilities, ability.id, 1);
          if (ids) void services.command('sheet:ability:reorder', { sheetId: sheet.id, ids });
        }),
        makeRowButton('×', 'Удалить способность', () => void services.command('sheet:ability:delete', { sheetId: sheet.id, id: ability.id }), true),
      );
      editor.append(tools);
      body.append(editor);
    }
    card.append(body);
    return card;
  };

  return {
    mount(nextContext) {
      context = nextContext;
      controls = buildRollControls();
      nextContext.elements.rollControlsHome.append(controls);
      refreshActorOptions();
    },

    dispose() {
      removeSheetNodes();
      controls?.remove();
      controls = undefined;
      actorSelect = undefined;
      actorRow = undefined;
      bonusInput = undefined;
      context = undefined;
    },

    renderRollControls() {
      refreshActorOptions();
    },

    renderSheet(sheet, options) {
      if (!context) return;
      removeSheetNodes();
      const services = context.services;

      const characteristics = sheetSection('Характеристики', 'sheet-characteristics-section');
      if (options.canRoll) {
        const hint = document.createElement('p');
        hint.className = 'panel-note';
        hint.textContent = 'Нажмите на название характеристики, чтобы открыть окно броска PbtA.';
        characteristics.append(hint);
      }
      const characteristicGrid = document.createElement('div');
      characteristicGrid.className = 'sheet-characteristics';
      for (const definition of pbtaSheetSchema.characteristics) {
        const card = document.createElement('div');
        card.className = 'sheet-characteristic';
        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'sheet-characteristic-name';
        name.textContent = definition.name;
        if (options.canRoll) {
          name.title = 'Подготовить бросок по этой характеристике';
          name.addEventListener('click', () => {
            if (bonusInput) bonusInput.value = String(sheet.characteristics[definition.key]);
            services.openRoll(sheet, definition.key, definition.name);
            const pending = services.getPendingRoll();
            if (pending && actorSelect && services.getIdentity().role === 'gm') {
              actorSelect.value = pending.characterOwnerId;
            }
          });
        } else {
          name.disabled = true;
          name.title = 'Только просмотр';
        }
        card.append(name);
        if (options.editing) {
          card.append(makeStepper(sheet.characteristics[definition.key], -1000, 1000, definition.name, (value) => {
            void services.command('sheet:update', { id: sheet.id, changes: { characteristics: { [definition.key]: value } } });
          }));
        } else {
          const value = document.createElement('span');
          value.className = 'sheet-characteristic-value';
          value.textContent = formatSigned(sheet.characteristics[definition.key]);
          card.append(value);
        }
        characteristicGrid.append(card);
      }
      characteristics.append(characteristicGrid);
      appendSheetNode(characteristics);

      const fate = sheetSection('Сила Судьбы', 'sheet-fate-section');
      const fateRow = document.createElement('div');
      fateRow.className = 'sheet-resource';
      const fateLabel = document.createElement('strong');
      fateLabel.textContent = 'Сила Судьбы';
      fateRow.append(fateLabel);
      if (options.canEdit) {
        fateRow.append(makeStepper(sheet.fate, -1_000_000_000, 1_000_000_000, 'Сила Судьбы', (value) => {
          void services.command('sheet:fate:update', { sheetId: sheet.id, value });
        }));
      } else {
        const value = document.createElement('span');
        value.className = 'sheet-resource-value';
        value.textContent = String(sheet.fate);
        fateRow.append(value);
      }
      const fateNote = document.createElement('p');
      fateNote.className = 'panel-note';
      fateNote.textContent = 'Не списывается автоматически при повторном броске — учитывайте расход вручную.';
      fate.append(fateRow, fateNote);
      appendSheetNode(fate);

      const counters = sheetSection('Дополнительные счётчики', 'sheet-counters-section');
      const sortedCounters = [...sheet.counters].sort((left, right) => left.orderIndex - right.orderIndex);
      if (!sortedCounters.length) {
        const empty = document.createElement('p');
        empty.className = 'panel-note';
        empty.textContent = 'Дополнительных счётчиков нет.';
        counters.append(empty);
      }
      for (const counter of sortedCounters) {
        const row = document.createElement('div');
        row.className = 'sheet-counter-row';
        if (options.editing) {
          const name = document.createElement('input');
          name.value = counter.name;
          name.maxLength = 80;
          name.setAttribute('aria-label', 'Название счётчика');
          name.addEventListener('change', () => void services.command('sheet:counter:update', { sheetId: sheet.id, id: counter.id, changes: { name: name.value } }));
          row.append(name, makeStepper(counter.value, -1_000_000_000, 1_000_000_000, counter.name, (value) => {
            void services.command('sheet:counter:update', { sheetId: sheet.id, id: counter.id, changes: { value } });
          }));
          const tools = document.createElement('div');
          tools.className = 'sheet-row-tools';
          tools.append(
            makeRowButton('↑', 'Переместить выше', () => {
              const ids = moveIds(sheet.counters, counter.id, -1);
              if (ids) void services.command('sheet:counter:reorder', { sheetId: sheet.id, ids });
            }),
            makeRowButton('↓', 'Переместить ниже', () => {
              const ids = moveIds(sheet.counters, counter.id, 1);
              if (ids) void services.command('sheet:counter:reorder', { sheetId: sheet.id, ids });
            }),
            makeRowButton('×', 'Удалить счётчик', () => void services.command('sheet:counter:delete', { sheetId: sheet.id, id: counter.id }), true),
          );
          row.append(tools);
        } else {
          const name = document.createElement('span');
          name.textContent = counter.name;
          if (options.canEdit) {
            row.append(name, makeStepper(counter.value, -1_000_000_000, 1_000_000_000, counter.name, (value) => {
              void services.command('sheet:counter:value', { sheetId: sheet.id, id: counter.id, value });
            }));
          } else {
            const value = document.createElement('strong');
            value.textContent = String(counter.value);
            row.append(name, value);
          }
        }
        counters.append(row);
      }
      if (options.editing) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'secondary sheet-add-button';
        add.textContent = '＋ Счётчик';
        add.addEventListener('click', () => {
          const name = window.prompt('Название счётчика', 'Ресурс');
          if (name?.trim()) void services.command('sheet:counter:create', { sheetId: sheet.id, name: name.trim(), value: 0 });
        });
        counters.append(add);
      }
      appendSheetNode(counters);

      const abilities = sheetSection('Особые способности', 'sheet-abilities-section');
      const identity = services.getIdentity();
      const collapsed = readCollapsedAbilities(localStorage, services.storageScope(), identity.participantId, sheet.id);
      const sortedAbilities = [...sheet.abilities].sort((left, right) => left.orderIndex - right.orderIndex);
      if (!sortedAbilities.length) {
        const empty = document.createElement('p');
        empty.className = 'panel-note';
        empty.textContent = 'Особых способностей нет.';
        abilities.append(empty);
      }
      for (const ability of sortedAbilities) {
        abilities.append(renderAbility(sheet, ability, options, collapsed.has(ability.id)));
      }
      if (options.editing) {
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'secondary sheet-add-button';
        add.textContent = '＋ Способность';
        add.addEventListener('click', () => {
          const name = window.prompt('Название способности', 'Новая способность');
          if (name?.trim()) void services.command('sheet:ability:create', { sheetId: sheet.id, name: name.trim() });
        });
        abilities.append(add);
      }
      appendSheetNode(abilities);
    },
  };
}
