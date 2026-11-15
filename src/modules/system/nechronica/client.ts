import type { CharacterSheet } from '../../../shared/board.js';
import type { SystemClientContext, SystemClientModule } from '../../client-contract.js';
import { sheetSection } from '../../../client/sheet-dom.js';

/**
 * Nechronica placeholder client. It owns its own small chunk and mounts only in
 * Nechronica rooms, so a PbtA room never downloads it. Real mechanics are out
 * of scope for stage 5; the shared panel shell and identity fields stay in core.
 */
export function createClientModule(): SystemClientModule {
  let context: SystemClientContext | undefined;
  let controls: HTMLElement | undefined;
  let placeholder: HTMLElement | undefined;

  return {
    mount(nextContext) {
      context = nextContext;
      controls = document.createElement('section');
      controls.className = 'dice-roll-controls';
      controls.setAttribute('aria-label', 'Броски Nechronica');
      const heading = document.createElement('h3');
      heading.textContent = 'Броски Nechronica';
      const note = document.createElement('p');
      note.className = 'panel-note';
      note.textContent = 'Система бросков Nechronica — находится в разработке.';
      controls.append(heading, note);
      nextContext.elements.rollControlsHome.append(controls);
    },

    dispose() {
      placeholder?.remove();
      placeholder = undefined;
      controls?.remove();
      controls = undefined;
      context = undefined;
    },

    renderRollControls() {
      /* The placeholder needs no dynamic state. */
    },

    renderSheet(sheet: CharacterSheet) {
      if (!context) return;
      placeholder?.remove();
      const section = sheetSection('Лист персонажа', 'sheet-placeholder-section');
      const note = document.createElement('p');
      note.className = 'panel-note sheet-placeholder';
      note.textContent = `Лист персонажа ${context.system.name} — находится в разработке`;
      section.append(note);
      placeholder = section;
      context.elements.sheet.append(section);
      void sheet;
    },
  };
}
