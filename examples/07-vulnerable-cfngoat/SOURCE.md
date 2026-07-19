# Source

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `cfngoat.yaml` | [`bridgecrewio/cfngoat`](https://github.com/bridgecrewio/cfngoat) | `cfngoat.yaml` | `0c09b69cfc3dbc6cb3ef01883415c35c588ced48` | https://github.com/bridgecrewio/cfngoat/blob/0c09b69cfc3dbc6cb3ef01883415c35c588ced48/cfngoat.yaml |

Fetched via the `master` branch on 2026-07-19; pinned above to the commit
that was `master`'s HEAD for this file at fetch time. `cfngoat` is
maintained by Bridgecrew specifically as a deliberately-insecure CFN
template for testing security-scanning tools.

**Modified from upstream, 2026-07-19 (post-fetch):** two pairs of hardcoded
AWS example credentials (lines 69–70 and 890–891 in the original) were
redacted to `<REDACTED-EXAMPLE-KEY-ID>` / `<REDACTED-EXAMPLE-SECRET-KEY>`.
These were AWS's own well-known placeholder credentials (`AKIAIOSFODNN7...`
/ `wJalrXUtnFEMI/K7...`, the same dummy values used throughout AWS's own
documentation) — not real secrets, and part of `cfngoat`'s intentional
"hardcoded secret in UserData / Lambda env vars" vulnerability
demonstrations. They matched GitHub's push-protection secret-scanning
pattern by format alone (it can't distinguish a placeholder from a live
key), which blocked the push. Redacting preserves the vulnerability
*pattern* cfngoat is demonstrating (a hardcoded secret exists in plaintext
in the template) without keeping a key-shaped string in the repo. This is
the one deviation from upstream in this file; everything else is
unmodified.
