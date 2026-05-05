import manifest from '../assets/pet/youyu/spritesheet-manifest.json';
import mainAtlasUrl from '../assets/pet/youyu/main-spritesheet.webp';
import extraAtlasUrl from '../assets/pet/youyu/extra-spritesheet.webp';
import type { DesktopPetState } from '../../shared/ipc';

type AtlasName = 'main' | 'extra';

type ManifestRow = {
  row: number;
  frames: number;
  sourceKeys: string[];
  profiles: string[];
};

export type PetAnimation = {
  state: DesktopPetState;
  atlas: AtlasName;
  imageUrl: string;
  row: number;
  frameIndexes: number[];
  frames: number;
  fps: number;
  loop: boolean;
  frameWidth: number;
  frameHeight: number;
  atlasColumns: number;
  atlasRows: number;
};

const atlasColumns = 8;
const atlasUrls: Record<AtlasName, string> = {
  main: mainAtlasUrl,
  extra: extraAtlasUrl
};

type StateConfig = {
  atlas: AtlasName;
  rowKey: string;
  frameIndexes: number[];
  fps: number;
  loop: boolean;
};

const stateConfig: Record<DesktopPetState, StateConfig> = {
  idle: { atlas: 'main', rowKey: 'idle', frameIndexes: [0, 1, 5, 1], fps: 4, loop: true },
  walkRight: { atlas: 'main', rowKey: 'walkRight', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 9, loop: true },
  walkLeft: { atlas: 'main', rowKey: 'walkLeft', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 9, loop: true },
  wave: { atlas: 'main', rowKey: 'wave', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 7, loop: false },
  jump: { atlas: 'main', rowKey: 'jump', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 8, loop: false },
  liftHold: { atlas: 'main', rowKey: 'drag', frameIndexes: [1], fps: 1, loop: true },
  drag: { atlas: 'main', rowKey: 'drag', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 7, loop: true },
  sleepWake: { atlas: 'main', rowKey: 'sleepWake', frameIndexes: [1, 2, 3, 2, 1], fps: 5, loop: false },
  focusWait: { atlas: 'main', rowKey: 'focusWait', frameIndexes: [0, 1, 2, 3], fps: 5, loop: true },
  happy: { atlas: 'main', rowKey: 'happy', frameIndexes: [4, 5, 4], fps: 4, loop: true },
  edgePeek: { atlas: 'extra', rowKey: 'edgePeek', frameIndexes: [0], fps: 1, loop: true },
  edgeLeft: { atlas: 'extra', rowKey: 'edgePeek', frameIndexes: [0], fps: 1, loop: true },
  edgeRight: { atlas: 'extra', rowKey: 'edgePeek', frameIndexes: [0], fps: 1, loop: true },
  fallRecover: { atlas: 'extra', rowKey: 'fallRecover', frameIndexes: [0, 1, 2, 3, 4], fps: 7, loop: false },
  annoyed: { atlas: 'extra', rowKey: 'annoyed', frameIndexes: [0, 1, 3, 4, 5], fps: 5, loop: true },
  comfortSad: { atlas: 'extra', rowKey: 'comfortSad', frameIndexes: [0, 1, 2, 3, 4, 5], fps: 5, loop: true },
  rewardObserve: { atlas: 'extra', rowKey: 'rewardObserve', frameIndexes: [2, 3, 4, 3], fps: 5, loop: true }
};

export function getPetAnimation(state: DesktopPetState): PetAnimation {
  const config = stateConfig[state];
  const rows = manifest.atlases[config.atlas].rows as Record<string, ManifestRow>;
  const atlasRows = Math.max(...Object.values(rows).map((candidate) => candidate.row)) + 1;
  const row = rows[config.rowKey];

  if (!row) {
    throw new Error(`Missing pet animation row: ${config.atlas}.${config.rowKey}`);
  }

  const frameIndexes = config.frameIndexes.filter((frameIndex) => frameIndex >= 0 && frameIndex < row.frames);
  if (frameIndexes.length === 0) {
    throw new Error(`Missing safe pet animation frames: ${config.atlas}.${config.rowKey}`);
  }

  return {
    state,
    atlas: config.atlas,
    imageUrl: atlasUrls[config.atlas],
    row: row.row,
    frameIndexes,
    frames: frameIndexes.length,
    fps: config.fps,
    loop: config.loop,
    frameWidth: manifest.frame.width,
    frameHeight: manifest.frame.height,
    atlasColumns,
    atlasRows
  };
}

export function getPetAnimationDurationMs(state: DesktopPetState): number {
  const animation = getPetAnimation(state);
  return Math.ceil((animation.frames / animation.fps) * 1000);
}

export const petStates = Object.keys(stateConfig) as DesktopPetState[];
