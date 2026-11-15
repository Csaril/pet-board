/** Builds the wire command for a PbtA check from an arbitrary characteristic. */
export interface PbtACharacteristicSource {
  name: string;
  bonus: number;
  characterId: string;
  ownerId: string;
}

export interface PbtARollOptions {
  situationalModifier: -1 | 0 | 1;
  disadvantage: boolean;
}

export function createPbtARollCommand(characteristic: PbtACharacteristicSource, options: PbtARollOptions) {
  return {
    type: 'dice:pbta',
    characteristicName: characteristic.name,
    characteristicBonus: characteristic.bonus,
    characterId: characteristic.characterId,
    characterOwnerId: characteristic.ownerId,
    actorId: characteristic.ownerId,
    situationalModifier: options.situationalModifier,
    disadvantage: options.disadvantage,
  };
}
