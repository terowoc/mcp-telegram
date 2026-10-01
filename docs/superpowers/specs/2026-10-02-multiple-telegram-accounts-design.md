# Multiple Telegram accounts in one hosted cabinet

The user requests a complete multi-account flow on the hosted Telegram MCP. Preserve existing primary connections and OAuth behavior, add up to five isolated connections per cabinet, and allow both browser management and explicit AI sender selection.

Each additional connection uses a private worker identity owned by the cabinet user. Existing worker, vault, media and policy boundaries continue to use that connection identity. A new ownership table is additive; existing primary identity stays unchanged. Internal connection identities cannot authenticate as cabinet users.

Cabinet API lists connections, creates named empty connections, runs the existing QR/2FA flow against an owned connection, changes its label and policy, disconnects or removes it. Queries select a connection explicitly; the primary is default. Browser selection stays local and never changes the AI default. Duplicate verified Telegram identities in the same cabinet are rejected before persistence. Up to five connections includes the primary, and pending connections count. Limits and mutations are serialized by cabinet owner.

Hosted SaaS tools expose optional telegramAccountId and a read-only telegram-list-accounts. Selection uses the returned private connection ID, not a Telegram peer ID. Omitting selection always uses primary. Catalog visibility is the union of connected accounts; actual execution uses the selected account's policy. No foreign selection, login/logout through AI, or policy bypass. Direct binary upload links retain the selected connection and enforce its current access; handles never transfer between accounts.

Adding/removing an account or changing access revokes cabinet OAuth grants before asynchronous shutdown. Consent describes all connections and their permissions. Removing the cabinet stops and purges every owned connection before deleting records. Password recovery and logout cancel all relevant login attempts. Existing registrations, file flows and stdio catalogs remain compatible.

Verification: migration/restart preservation, capacity, duplicate rejection, two-owner denial, QR/2FA/retry/cancellation, account-specific policy, actual hosted tool selection, direct uploads, lifecycle cleanup, dashboard typecheck/build/browser smoke, complete server suite, independent code review, then production deployment with existing rollback pipeline. Live QR completion needs the user's phone; do not claim it was exercised against real accounts.
