import type { PreferredNodeRegion, RegionFallback, RemoteControlConfig } from '../../shared/ipc';

export type NodeSelectionPolicy = {
  preferredRegion: PreferredNodeRegion;
  regionFallback: RegionFallback;
};

export const defaultNodeSelectionPolicy: NodeSelectionPolicy = {
  preferredRegion: 'jp',
  regionFallback: 'global'
};

export const preferredNodeRegions: PreferredNodeRegion[] = ['auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr'];
export const regionFallbacks: RegionFallback[] = ['strict', 'global'];

const regionPatterns: Record<Exclude<PreferredNodeRegion, 'auto'>, RegExp[]> = {
  jp: [
    /(?:^|[^a-z0-9])(?:jp|jpn|japan|tokyo|osaka|nagoya|fukuoka)(?:$|[^a-z0-9])/i,
    /(?:日本|东京|東京|大阪|名古屋|福冈|福岡|\u{1f1ef}\u{1f1f5})/iu
  ],
  hk: [/(?:^|[^a-z0-9])(?:hk|hkg|hong[ -]?kong)(?:$|[^a-z0-9])/i, /(?:香港|\u{1f1ed}\u{1f1f0})/u],
  tw: [
    /(?:^|[^a-z0-9])(?:tw|twn|taiwan|taipei|kaohsiung)(?:$|[^a-z0-9])/i,
    /(?:台湾|台灣|台北|高雄|\u{1f1f9}\u{1f1fc})/u
  ],
  sg: [/(?:^|[^a-z0-9])(?:sg|sgp|singapore)(?:$|[^a-z0-9])/i, /(?:新加坡|狮城|獅城|\u{1f1f8}\u{1f1ec})/u],
  us: [
    /(?:^|[^a-z0-9])(?:us|usa|united[ -]?states|america|los[ -]?angeles|san[ -]?jose|seattle)(?:$|[^a-z0-9])/i,
    /(?:美国|美國|洛杉矶|洛杉磯|圣何塞|聖何塞|西雅图|西雅圖|\u{1f1fa}\u{1f1f8})/u
  ],
  kr: [/(?:^|[^a-z0-9])(?:kr|kor|korea|seoul)(?:$|[^a-z0-9])/i, /(?:韩国|韓國|首尔|首爾|\u{1f1f0}\u{1f1f7})/u]
};

export function resolveNodeSelectionPolicy(config?: RemoteControlConfig): NodeSelectionPolicy {
  const preferredRegion = preferredNodeRegions.includes(config?.preferredRegion as PreferredNodeRegion)
    ? (config?.preferredRegion as PreferredNodeRegion)
    : defaultNodeSelectionPolicy.preferredRegion;
  const regionFallback = regionFallbacks.includes(config?.regionFallback as RegionFallback)
    ? (config?.regionFallback as RegionFallback)
    : defaultNodeSelectionPolicy.regionFallback;
  return {
    preferredRegion,
    regionFallback: preferredRegion === 'auto' ? 'global' : regionFallback
  };
}

export function isNodeInPreferredRegion(name: string, region: PreferredNodeRegion): boolean {
  return region === 'auto' || regionPatterns[region].some((pattern) => pattern.test(name));
}

export function expectedExitRegionCode(region: PreferredNodeRegion): string | undefined {
  return region === 'auto' ? undefined : region.toUpperCase();
}

export function preferredRegionLabel(region: PreferredNodeRegion): string {
  return (
    {
      auto: '低延迟',
      jp: '日本',
      hk: '香港',
      tw: '台湾',
      sg: '新加坡',
      us: '美国',
      kr: '韩国'
    } satisfies Record<PreferredNodeRegion, string>
  )[region];
}

export function detectNodeRegion(name: string): Exclude<PreferredNodeRegion, 'auto'> | undefined {
  return (preferredNodeRegions.filter((region) => region !== 'auto') as Exclude<PreferredNodeRegion, 'auto'>[]).find(
    (region) => isNodeInPreferredRegion(name, region)
  );
}

export function exitRegionLabel(code: string | undefined): string {
  const normalized = code?.toLowerCase() as Exclude<PreferredNodeRegion, 'auto'> | undefined;
  return normalized && preferredNodeRegions.includes(normalized) ? preferredRegionLabel(normalized) : '其他地区';
}
