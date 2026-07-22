# Let group-scoped agents act as members during leased runs

A session agent receives the same authority over sessions and resources as a member of exactly one access group, independent of the initiating user's memberships, and its descendants remain in that group. This broad authority enables meta-agent coordination without crossing group boundaries, but it exists only during an active validly leased run; sessions provide durable scope and audit identity rather than reusable credentials, and organization-level cross-group orchestration remains a separate future principal.
