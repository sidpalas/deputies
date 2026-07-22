# Keep session ownership immutable

The access group selected when a session is created owns that session for its lifetime; visibility and write policy remain editable, but the owning group cannot change. Moving a session would transfer its complete history and session-owned resources across a security boundary without coherently moving lineage, integrations, automations, environment access, or independently owned collaborative resources, so a session created in the wrong group is archived and recreated instead.
