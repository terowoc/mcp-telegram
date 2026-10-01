# Implementation plan

Implement in this session; independent review before integration.

1. Write failing storage/identity tests for ownership, five-account capacity, duplicate identity, selected sender, foreign denial and policy. Add schema v4 ownership table and transactional connection creation; keep primary data and encryption untouched.
2. Write failing cabinet route tests for create/list/select/label/delete, QR password ownership, cleanup and CSRF. Extend existing routes with explicit account query and owner-wide locking. Revoke OAuth on account and permission changes. Stop/purge owned connections on deletion and recovery.
3. Write failing hosted catalog/MCP and upload tests. Add list tool and optional selector only for hosted SaaS; route to immutable selected worker, strip selector before worker execution. Preserve native file metadata and direct-upload selection.
4. Extend dashboard with connection selector, named add form, rename/remove actions, selected QR/policy/disconnect operations. Guard stale replies using selection/epoch; persist only selected ID locally. Document limits, default account and reconnect requirements.
5. Run targeted then full tests, backend/dashboard builds and lint. Request independent reviewer for isolation, grants, concurrency and lifecycle. Address findings, create/attach PR, integrate/deploy and verify health and deployed assets. Report actual test evidence and remaining live-phone verification.

Review focus: stale responses during selection; foreign IDs and malformed selectors; reconnecting different identity after disconnect; worker shutdown races; uploads accidentally landing in primary account.
