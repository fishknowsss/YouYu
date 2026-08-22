export type WorkerRouteContext<Environment> = {
  request: Request;
  env: Environment;
  url: URL;
  match?: RegExpMatchArray;
};

export type WorkerRoute<Environment> = {
  method?: string;
  path?: string | RegExp;
  handle: (context: WorkerRouteContext<Environment>) => Response | Promise<Response>;
};

type WorkerRouteFallback<Environment> = (context: WorkerRouteContext<Environment>) => Response | Promise<Response>;

export function createWorkerRouter<Environment>(
  routes: readonly WorkerRoute<Environment>[],
  fallback: WorkerRouteFallback<Environment>
) {
  return async (request: Request, env: Environment, url = new URL(request.url)): Promise<Response> => {
    for (const route of routes) {
      if (route.method !== undefined && route.method !== request.method) continue;

      let match: RegExpMatchArray | undefined;
      if (typeof route.path === 'string') {
        if (route.path !== url.pathname) continue;
      } else if (route.path instanceof RegExp) {
        match = url.pathname.match(route.path) ?? undefined;
        if (!match) continue;
      }

      return route.handle({ request, env, url, match });
    }

    return fallback({ request, env, url });
  };
}
