# Use RRULE for scheduled follow-ups only

Scheduled follow-ups use RFC 5545 recurrence rules with an IANA time zone and explicit product-level occurrence bounds. Existing tenant-wide scheduled automations retain their five-field UTC cron contract; any RRULE support or migration for automations will be designed separately so existing schedules keep identical timing semantics.
