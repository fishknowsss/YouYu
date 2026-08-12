type ActiveOperation<Result> = {
  controller: AbortController;
  promise: Promise<Result>;
};

export type LatestOperationContext = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

/**
 * Owns one replaceable asynchronous operation. Transitions are serialized so a
 * replacement cannot start until the superseded operation has observed abort
 * and fully settled.
 */
export class LatestOperationCoordinator<Result> {
  private active: ActiveOperation<Result> | undefined;
  private transition: Promise<unknown> = Promise.resolve();

  replace(action: (context: LatestOperationContext) => Promise<Result>): Promise<Result> {
    return this.enqueueTransition(async () => {
      await this.cancelActive();
      return this.startOperation(action);
    }).then((operation) => operation.promise);
  }

  /**
   * Joins the current operation when one is already running. This keeps
   * background callers from canceling equivalent foreground work merely
   * because their timers happened to fire later.
   */
  coalesce(action: (context: LatestOperationContext) => Promise<Result>): Promise<Result> {
    return this.enqueueTransition(() => this.active ?? this.startOperation(action)).then(
      (operation) => operation.promise
    );
  }

  cancel(): Promise<void> {
    return this.enqueueTransition(() => this.cancelActive());
  }

  cancelThen<Value>(action: () => Promise<Value>): Promise<Value> {
    return this.enqueueTransition(async () => {
      await this.cancelActive();
      return action();
    });
  }

  private enqueueTransition<Value>(action: () => Value | Promise<Value>): Promise<Value> {
    const result = this.transition.then(action, action);
    this.transition = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private startOperation(action: (context: LatestOperationContext) => Promise<Result>): ActiveOperation<Result> {
    const controller = new AbortController();
    const operation = {} as ActiveOperation<Result>;
    operation.controller = controller;
    operation.promise = Promise.resolve()
      .then(() =>
        action({
          signal: controller.signal,
          isCurrent: () => this.active === operation && !controller.signal.aborted
        })
      )
      .finally(() => {
        if (this.active === operation) this.active = undefined;
      });
    this.active = operation;
    return operation;
  }

  private async cancelActive(): Promise<void> {
    const operation = this.active;
    if (!operation) return;
    operation.controller.abort(new Error('operation replaced'));
    await operation.promise.catch(() => undefined);
    if (this.active === operation) this.active = undefined;
  }
}
