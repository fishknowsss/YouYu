export function createNodeSwitchCooldown(options: { cooldownMs: number; now?: () => number }) {
  const abandoned = new Map<string, number>();

  function now(): number {
    return options.now?.() ?? Date.now();
  }

  function prune(at: number): void {
    for (const [name, rememberedAt] of abandoned) {
      if (at - rememberedAt >= options.cooldownMs) abandoned.delete(name);
    }
  }

  return {
    remember(name: string): void {
      const trimmed = name.trim();
      if (!trimmed) return;
      abandoned.set(trimmed, now());
    },
    avoidWith(current: string): string[] {
      const at = now();
      prune(at);
      const names = new Set<string>();
      const trimmed = current.trim();
      if (trimmed) names.add(trimmed);
      for (const name of abandoned.keys()) names.add(name);
      return [...names];
    }
  };
}
