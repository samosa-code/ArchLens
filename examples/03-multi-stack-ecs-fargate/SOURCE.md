# Source

| File | Upstream repo | Path | Commit (pinned) | Permalink |
|---|---|---|---|---|
| `network-stack/template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/clusters/public-vpc.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/clusters/public-vpc.yaml |
| `service-stack/template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/services/public-service.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/services/public-service.yaml |
| `private-subnet-public-service/template.yaml` | [`aws-cloudformation/aws-cloudformation-templates`](https://github.com/aws-cloudformation/aws-cloudformation-templates) | `ECS/FargateLaunchType/services/private-subnet-public-service.yaml` | `d92ae9b9a579db627c58e3c1c630440f42ca69b9` | https://github.com/aws-cloudformation/aws-cloudformation-templates/blob/d92ae9b9a579db627c58e3c1c630440f42ca69b9/ECS/FargateLaunchType/services/private-subnet-public-service.yaml |

Fetched via the `main` branch on 2026-07-19 (first two files) and
2026-07-20 (`private-subnet-public-service`, added for Sprint 2 fixture
coverage); pinned above to the commit that was `main`'s HEAD for each file
at fetch time (same commit for all three — all last touched by the same
repo reorg). Unmodified from upstream. This is a real upstream-linked
trio: AWS's own docs describe deploying `network-stack` first, then any
number of service stacks against its exports —
`private-subnet-public-service` is a genuine sibling consumer of the same
network stack as `service-stack`, sharing several of the same exports
(`ClusterName`, `VPCId`, `PublicListener`) — confirmed by running both
through ArchLens's own resolver and comparing the resolved `exportName`
values, not just by inspection.
