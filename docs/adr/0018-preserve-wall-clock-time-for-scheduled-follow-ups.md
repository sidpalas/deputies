# Preserve wall-clock time for scheduled follow-ups

Recurring scheduled follow-ups retain an IANA time zone and preserve the user's local wall-clock schedule across daylight-saving changes, while each occurrence is recorded as an absolute instant. This deliberately differs from tenant-wide scheduled automations' UTC-only cron semantics because session follow-ups are authored as human-local commitments whose apparent time should not drift.
