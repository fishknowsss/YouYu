UPDATE users
SET can_edit_managed_config = 0
WHERE can_edit_managed_config IS NULL OR can_edit_managed_config NOT IN (0, 1);

DELETE FROM user_remote_config
WHERE enabled IS NULL
  AND subscription_url IS NULL
  AND rule_profile IS NULL
  AND preferred_region IS NULL
  AND region_fallback IS NULL
  AND preferred_node IS NULL
  AND preferred_strategy IS NULL
  AND direct_rules IS NULL
  AND proxy_rules IS NULL;
