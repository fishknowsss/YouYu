export type RuntimeIntentController = {
  requestStart: () => number;
  cancel: () => void;
  capture: () => number | undefined;
  isCurrent: (generation: number) => boolean;
};

export function createRuntimeIntentController(): RuntimeIntentController {
  let desired = false;
  let generation = 0;

  return {
    requestStart() {
      desired = true;
      generation += 1;
      return generation;
    },
    cancel() {
      desired = false;
      generation += 1;
    },
    capture() {
      return desired ? generation : undefined;
    },
    isCurrent(candidate) {
      return desired && candidate === generation;
    }
  };
}
