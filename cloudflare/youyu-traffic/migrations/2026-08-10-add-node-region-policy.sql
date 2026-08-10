INSERT OR IGNORE INTO remote_config
  (id, version, enabled, subscription_url, rule_profile, preferred_region, region_fallback,
   preferred_node, preferred_strategy, direct_rules, proxy_rules, anomaly_threshold_bytes, updated_at)
VALUES
  (1, 1, 1, NULL, NULL, 'jp', 'global', NULL, NULL, '[]', '[]', 1073741824,
   strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

UPDATE remote_config
SET preferred_region = CASE
      WHEN preferred_region IN ('auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr') THEN preferred_region
      ELSE 'jp'
    END,
    region_fallback = CASE
      WHEN region_fallback IN ('strict', 'global') THEN region_fallback
      ELSE 'global'
    END,
    version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE preferred_region IS NULL
   OR preferred_region NOT IN ('auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr')
   OR region_fallback IS NULL
   OR region_fallback NOT IN ('strict', 'global');

UPDATE user_remote_config
SET preferred_region = NULL
WHERE preferred_region IS NOT NULL
  AND preferred_region NOT IN ('auto', 'jp', 'hk', 'tw', 'sg', 'us', 'kr');

UPDATE user_remote_config
SET region_fallback = NULL
WHERE region_fallback IS NOT NULL
  AND region_fallback NOT IN ('strict', 'global');
