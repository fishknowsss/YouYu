import type { Rectangle } from 'electron';

export type NoticeSize = {
  width: number;
  height: number;
};

export type NoticeAnchor = 'above' | 'below' | 'left' | 'right';

export type NoticePlacement = Rectangle & {
  anchor: NoticeAnchor;
};

const edgeThreshold = 18;
const safetyMargin = 12;
const defaultGap = 12;

/**
 * Resolves the companion notice position from geometry instead of the pet's
 * animation state. A bottom edge wins at corners so a bottom-right pet keeps
 * its notice above it rather than pushing the card off the display.
 */
export function resolvePetNoticePlacement(
  petBounds: Rectangle,
  workArea: Rectangle,
  noticeSize: NoticeSize,
  options: { gap?: number; margin?: number } = {}
): NoticePlacement {
  const gap = options.gap ?? defaultGap;
  const margin = options.margin ?? safetyMargin;
  const bottomGap = workArea.y + workArea.height - (petBounds.y + petBounds.height);
  const leftGap = petBounds.x - workArea.x;
  const rightGap = workArea.x + workArea.width - (petBounds.x + petBounds.width);
  const topGap = petBounds.y - workArea.y;

  const orderedAnchors: NoticeAnchor[] =
    bottomGap <= edgeThreshold
      ? ['above', rightGap >= leftGap ? 'left' : 'right', 'below']
      : leftGap <= edgeThreshold
        ? ['right', 'above', 'below']
        : rightGap <= edgeThreshold
          ? ['left', 'above', 'below']
          : topGap <= edgeThreshold
            ? ['below', rightGap >= leftGap ? 'left' : 'right', 'above']
            : ['above', rightGap >= leftGap ? 'right' : 'left', 'below'];

  for (const anchor of orderedAnchors) {
    const candidate = positionForAnchor(petBounds, noticeSize, anchor, gap);
    if (fitsWorkArea(candidate, workArea, margin) && !rectanglesIntersect(candidate, petBounds)) {
      return { ...candidate, anchor };
    }
  }

  const fallbackAnchor = orderedAnchors[0];
  return {
    ...clampToWorkArea(positionForAnchor(petBounds, noticeSize, fallbackAnchor, gap), workArea, margin),
    anchor: fallbackAnchor
  };
}

function positionForAnchor(petBounds: Rectangle, noticeSize: NoticeSize, anchor: NoticeAnchor, gap: number): Rectangle {
  switch (anchor) {
    case 'above':
      return {
        width: noticeSize.width,
        height: noticeSize.height,
        x: Math.round(petBounds.x + (petBounds.width - noticeSize.width) / 2),
        y: petBounds.y - noticeSize.height - gap
      };
    case 'below':
      return {
        width: noticeSize.width,
        height: noticeSize.height,
        x: Math.round(petBounds.x + (petBounds.width - noticeSize.width) / 2),
        y: petBounds.y + petBounds.height + gap
      };
    case 'left':
      return {
        width: noticeSize.width,
        height: noticeSize.height,
        x: petBounds.x - noticeSize.width - gap,
        y: Math.round(petBounds.y + (petBounds.height - noticeSize.height) / 2)
      };
    case 'right':
      return {
        width: noticeSize.width,
        height: noticeSize.height,
        x: petBounds.x + petBounds.width + gap,
        y: Math.round(petBounds.y + (petBounds.height - noticeSize.height) / 2)
      };
  }
}

function fitsWorkArea(bounds: Rectangle, workArea: Rectangle, margin: number): boolean {
  return (
    bounds.x >= workArea.x + margin &&
    bounds.y >= workArea.y + margin &&
    bounds.x + bounds.width <= workArea.x + workArea.width - margin &&
    bounds.y + bounds.height <= workArea.y + workArea.height - margin
  );
}

function clampToWorkArea(bounds: Rectangle, workArea: Rectangle, margin: number): Rectangle {
  const minimumX = workArea.x + margin;
  const minimumY = workArea.y + margin;
  const maximumX = Math.max(minimumX, workArea.x + workArea.width - margin - bounds.width);
  const maximumY = Math.max(minimumY, workArea.y + workArea.height - margin - bounds.height);
  return {
    ...bounds,
    x: Math.min(Math.max(bounds.x, minimumX), maximumX),
    y: Math.min(Math.max(bounds.y, minimumY), maximumY)
  };
}

function rectanglesIntersect(left: Rectangle, right: Rectangle): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}
