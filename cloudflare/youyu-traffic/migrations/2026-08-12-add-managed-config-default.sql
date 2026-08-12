UPDATE remote_config
SET can_edit_managed_config = 1
WHERE can_edit_managed_config IS NULL OR can_edit_managed_config NOT IN (0, 1);

UPDATE users
SET can_edit_managed_config_override = NULL
WHERE can_edit_managed_config_override IS NOT NULL
  AND can_edit_managed_config_override NOT IN (0, 1);
