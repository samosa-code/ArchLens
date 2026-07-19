# Source

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `network-stack/template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/clusters/public-vpc.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/clusters/public-vpc.yaml |
| `service-stack/template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/services/public-service.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/services/public-service.yaml |

Fetched via the `main` branch on 2026-07-19; pinned above to the commit that
was `main`'s HEAD for both files at fetch time (same commit — both last
touched by the same repo reorg). Unmodified from upstream. This is a real
upstream-linked pair: AWS's own docs describe deploying `network-stack`
first, then `service-stack` against its exports.
