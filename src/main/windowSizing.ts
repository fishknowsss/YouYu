export type WindowSize = {
  width: number;
  height: number;
};

export type MainWindowMetrics = WindowSize & {
  minWidth: number;
  minHeight: number;
  zoomFactor: number;
};

const baselineDisplay: WindowSize = { width: 1920, height: 1080 };
const baselineWindow: WindowSize = { width: 900, height: 600 };
const minimumDisplayScale = 0.5;
const maximumDisplayScale = 2;

export function calculateMainWindowMetrics(displaySize: WindowSize, workAreaSize: WindowSize): MainWindowMetrics {
  const displayScale = Math.min(
    positiveRatio(displaySize.width, baselineDisplay.width),
    positiveRatio(displaySize.height, baselineDisplay.height)
  );
  const availableScale = Math.min(
    positiveRatio(workAreaSize.width, baselineWindow.width),
    positiveRatio(workAreaSize.height, baselineWindow.height)
  );
  const boundedDisplayScale = Math.min(maximumDisplayScale, Math.max(minimumDisplayScale, displayScale));
  const targetScale = Math.min(boundedDisplayScale, availableScale);
  const width = Math.max(1, Math.round(baselineWindow.width * targetScale));
  const height = Math.max(1, Math.round(baselineWindow.height * targetScale));
  const zoomFactor = Math.min(width / baselineWindow.width, height / baselineWindow.height);

  return {
    width,
    height,
    minWidth: width,
    minHeight: height,
    zoomFactor
  };
}

function positiveRatio(value: number, baseline: number): number {
  return Number.isFinite(value) && value > 0 ? value / baseline : 1;
}
