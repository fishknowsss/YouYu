import { useMemo, useState } from 'react';
import type {
  AppSnapshot,
  ConnectivityCategory,
  ConnectivityResult,
  ConnectivityServiceKey,
  ConnectivityStatus
} from '../../shared/ipc';

type TestPageProps = {
  snapshot: AppSnapshot;
};

type TestRow = ConnectivityResult & {
  testing?: boolean;
};

type TestResults = Record<ConnectivityServiceKey, TestRow>;

const services: Array<{
  key: ConnectivityServiceKey;
  name: string;
  url: string;
  category: ConnectivityCategory;
}> = [
  { key: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com', category: 'ai' },
  { key: 'claude', name: 'Claude', url: 'https://claude.ai', category: 'ai' },
  { key: 'gemini', name: 'Gemini', url: 'https://gemini.google.com', category: 'ai' },
  { key: 'flow', name: 'Flow', url: 'https://labs.google/fx/tools/flow', category: 'special' },
  { key: 'runway', name: 'Runway', url: 'https://app.runwayml.com', category: 'ai' },
  { key: 'bytedance', name: '字节跳动', url: 'https://www.bytedance.com', category: 'global' },
  { key: 'tencent', name: '腾讯', url: 'https://www.tencent.com', category: 'domestic' },
  { key: 'google', name: 'Google', url: 'https://www.google.com', category: 'global' },
  { key: 'x', name: 'X', url: 'https://x.com', category: 'global' },
  { key: 'cloudflare', name: 'Cloudflare', url: 'https://www.cloudflare.com', category: 'global' },
  { key: 'ehentai', name: 'E-Hentai', url: 'https://e-hentai.org', category: 'global' }
];

let cachedResults: TestResults | undefined;
let cachedActiveKey: ConnectivityServiceKey = 'chatgpt';

export function TestPage({ snapshot }: TestPageProps) {
  const [results, setResults] = useState<TestResults>(() => getCachedResults());
  const [activeKey, setActiveKey] = useState<ConnectivityServiceKey>(() => cachedActiveKey);
  const [busyAll, setBusyAll] = useState(false);
  const apiReady = Boolean(window.youyu);
  const proxyReady = snapshot.status === 'running';
  const rows = useMemo(() => services.map((service) => results[service.key]), [results]);
  const active = results[activeKey];
  const summary = getSummary(rows);

  async function testOne(key: ConnectivityServiceKey) {
    const api = window.youyu;
    if (!api || !proxyReady) return;

    selectActiveKey(key);
    commitResults((current) => ({
      ...current,
      [key]: {
        ...current[key],
        testing: true
      }
    }));
    try {
      const result = await api.testConnectivity(key);
      commitResults((current) => ({
        ...current,
        [key]: result
      }));
    } catch (error) {
      commitResults((current) => ({
        ...current,
        [key]: {
          ...current[key],
          status: 'failed',
          statusText: '失败',
          checkedAt: new Date().toISOString(),
          testing: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }));
    }
  }

  async function testAll() {
    const api = window.youyu;
    if (!api || !proxyReady) return;

    setBusyAll(true);
    commitResults((current) => markAllTesting(current, true));
    try {
      const nextResults = await api.testAllConnectivity();
      commitResults((current) => {
        const next = { ...current };
        for (const result of nextResults) {
          next[result.key] = result;
        }
        return next;
      });
      selectActiveKey('chatgpt');
    } finally {
      setBusyAll(false);
      commitResults((current) => markAllTesting(current, false));
    }
  }

  function selectActiveKey(key: ConnectivityServiceKey) {
    cachedActiveKey = key;
    setActiveKey(key);
  }

  function commitResults(updater: (current: TestResults) => TestResults) {
    const next = updater(getCachedResults());
    cachedResults = next;
    setResults(next);
  }

  return (
    <section className="workspace advanced-workspace test-workspace" aria-label="测试">
      <header className="workspace-header test-header">
        <div>
          <h1>测试</h1>
          <p>{proxyReady ? `当前节点：${snapshot.currentNode}` : '先启动代理'}</p>
        </div>
        <div className="header-actions">
          <button className="secondary-button test-all-button" disabled={!apiReady || !proxyReady || busyAll} onClick={testAll}>
            测全部
          </button>
        </div>
      </header>

      <div className="test-panel">
        <div className="test-summary" aria-label="测试概览">
          <SummaryItem label="可用" value={summary.available} tone="available" />
          <SummaryItem label="受限" value={summary.blocked} tone="failed" />
          <SummaryItem label="出口" value={summary.ipCount} />
          <SummaryItem label="平均" value={summary.averageMs ? `${summary.averageMs} ms` : '-'} />
        </div>

        <div className="route-test-table" role="table" aria-label="网站分流测试">
          <div className="route-test-head" role="row">
            <span>网站</span>
            <span>类型</span>
            <span>状态</span>
            <span>出口 IP</span>
            <span>归属地</span>
            <span>耗时</span>
            <span>策略链</span>
            <span />
          </div>
          <div className="route-test-body">
            {rows.map((row) => (
              <div
                key={row.key}
                className={`route-test-row ${activeKey === row.key ? 'active' : ''}`}
                role="row"
                tabIndex={0}
                onClick={() => selectActiveKey(row.key)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    selectActiveKey(row.key);
                  }
                }}
              >
                <span className="test-service-name">{row.name}</span>
                <span className={`test-category ${row.category ?? 'global'}`}>{getCategoryText(row.category)}</span>
                <span className={`test-status ${getStatusClass(row.status, row.testing)}`}>
                  {row.testing ? '测试中' : row.statusText}
                </span>
                <span className="test-ip">{row.ip || '-'}</span>
                <span className="test-region">{row.region || '-'}</span>
                <span className="test-number">{formatMs(row.timings.totalMs)}</span>
                <span className="test-chain">{row.chains?.length ? row.chains.join(' / ') : '-'}</span>
                <button
                  className="test-retry"
                  disabled={!apiReady || !proxyReady || row.testing || busyAll}
                  onClick={(event) => {
                    event.stopPropagation();
                    void testOne(row.key);
                  }}
                >
                  重测
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="test-detail-strip" aria-label="测试详情">
          <div>
            <span>选中</span>
            <strong>{active.name}</strong>
          </div>
          <div>
            <span>地址</span>
            <strong>{active.finalUrl || active.url}</strong>
          </div>
          <div>
            <span>规则</span>
            <strong>{formatRule(active)}</strong>
          </div>
          <div>
            <span>HTTP</span>
            <strong>{active.httpCode ?? '-'}</strong>
          </div>
          {active.error && (
            <div className="test-detail-error">
              <span>错误</span>
              <strong>{active.error}</strong>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SummaryItem({
  label,
  value,
  tone
}: {
  label: string;
  value: number | string;
  tone?: 'available' | 'failed';
}) {
  return (
    <div className={`test-summary-item ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function getCachedResults(): TestResults {
  cachedResults ??= createInitialResults();
  return cachedResults;
}

function createInitialResults(): TestResults {
  return Object.fromEntries(
    services.map((service) => [
      service.key,
      {
        key: service.key,
        name: service.name,
        url: service.url,
        category: service.category,
        status: 'untested',
        statusText: '未测',
        reachability: 'unknown',
        timings: {}
      }
    ])
  ) as TestResults;
}

function markAllTesting(
  current: TestResults,
  testing: boolean
): TestResults {
  const next = { ...current };
  for (const key of Object.keys(next) as ConnectivityServiceKey[]) {
    next[key] = { ...next[key], testing };
  }
  return next;
}

function getSummary(rows: TestRow[]) {
  const tested = rows.filter((row) => row.status !== 'untested');
  const totalMs = tested
    .map((row) => row.timings.totalMs)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const averageMs = totalMs.length ? Math.round(totalMs.reduce((sum, value) => sum + value, 0) / totalMs.length) : undefined;
  return {
    available: rows.filter((row) => row.status === 'available').length,
    blocked: rows.filter((row) => row.status === 'blocked' || row.status === 'timeout' || row.status === 'failed').length,
    ipCount: new Set(rows.map((row) => row.ip).filter(Boolean)).size,
    averageMs
  };
}

function getStatusClass(status: ConnectivityStatus, testing?: boolean): string {
  if (testing) return 'testing';
  if (status === 'available') return 'available';
  if (status === 'blocked') return 'blocked';
  if (status === 'timeout' || status === 'failed') return 'failed';
  return 'untested';
}

function getCategoryText(category?: ConnectivityCategory): string {
  if (category === 'domestic') return '国内';
  if (category === 'ai') return 'AI';
  if (category === 'special') return '专项';
  return '国际';
}

function formatMs(value?: number): string {
  return typeof value === 'number' && value > 0 ? `${value} ms` : '-';
}

function formatRule(result: TestRow): string {
  if (!result.rule) return '-';
  return result.rulePayload ? `${result.rule} ${result.rulePayload}` : result.rule;
}
