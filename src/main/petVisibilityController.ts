export type PetVisibilityController = {
  setUserRequestedVisible: (visible: boolean) => void;
  setFullscreenSuppressed: (suppressed: boolean) => void;
  isUserRequestedVisible: () => boolean;
  isFullscreenSuppressed: () => boolean;
  isVisible: () => boolean;
};

export function createPetVisibilityController(options: {
  initialUserRequestedVisible: boolean;
  onVisibilityChange: (visible: boolean) => void;
}): PetVisibilityController {
  let userRequestedVisible = options.initialUserRequestedVisible;
  let fullscreenSuppressed = false;
  let visible = userRequestedVisible;

  const sync = () => {
    const nextVisible = userRequestedVisible && !fullscreenSuppressed;
    if (nextVisible === visible) return;
    visible = nextVisible;
    options.onVisibilityChange(visible);
  };

  return {
    setUserRequestedVisible(nextVisible) {
      userRequestedVisible = nextVisible;
      sync();
    },
    setFullscreenSuppressed(nextSuppressed) {
      fullscreenSuppressed = nextSuppressed;
      sync();
    },
    isUserRequestedVisible: () => userRequestedVisible,
    isFullscreenSuppressed: () => fullscreenSuppressed,
    isVisible: () => visible
  };
}
