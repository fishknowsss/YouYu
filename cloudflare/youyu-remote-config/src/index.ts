export interface Env {
  SUBSCRIPTION_URL?: string;
  DEFAULT_NODE_KEYWORDS?: string;
}

type RemoteConfig = {
  enabled: boolean;
  subscriptionUrl: string;
  defaultNode: {
    keywords: string[];
  };
  version: number;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: corsHeaders()
      });
    }

    if (url.pathname !== '/' && url.pathname !== '/config.json') {
      return new Response('Not Found', {
        status: 404,
        headers: corsHeaders()
      });
    }

    const subscriptionUrl = env.SUBSCRIPTION_URL?.trim();
    if (!subscriptionUrl) {
      return json(
        {
          enabled: false,
          subscriptionUrl: '',
          defaultNode: {
            keywords: []
          },
          version: 1
        },
        503
      );
    }

    const config: RemoteConfig = {
      enabled: true,
      subscriptionUrl,
      defaultNode: {
        keywords: parseKeywords(env.DEFAULT_NODE_KEYWORDS)
      },
      version: 1
    };

    return json(config, 200);
  }
};

function parseKeywords(value: string | undefined): string[] {
  if (!value) return [];

  const keywords: string[] = [];
  for (const item of value.split(',')) {
    const keyword = item.trim();
    if (keyword && !keywords.includes(keyword)) {
      keywords.push(keyword);
    }
  }
  return keywords.slice(0, 8);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

function corsHeaders(): HeadersInit {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS'
  };
}
