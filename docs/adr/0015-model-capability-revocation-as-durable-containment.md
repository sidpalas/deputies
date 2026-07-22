# Model capability revocation as durable containment

Repository and credential-backed capability access is granted independently to groups, and every session retains the cumulative set of capabilities materialized into its execution or model context. Revocation first atomically denies new authority, mutations, and credential issuance, then durably cancels affected work and destroys or quarantines executable sandbox state before reporting containment complete; this two-phase model is required because policy changes are transactional while remote cleanup is asynchronous and fallible.
