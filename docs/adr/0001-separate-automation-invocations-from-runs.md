# Separate automation invocations from runs

Automation invocations and agent runs represent different lifecycle concepts: an invocation is the durable activation of an automation that creates or attempts to create a session, while a run is the worker execution attempt for claimed session messages. We model automation invocations separately so scheduled and future event-driven automations can record created, skipped, and failed activations without overloading run leases, run status, or worker execution history.
