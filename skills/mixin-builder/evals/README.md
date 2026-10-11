# Evals — release gate for mixin-builder

Run every prompt below through the agent with ONLY this skill installed, in a clean project directory, before tagging a release. Grade against the **passes when** list; any **fails when** observed = block release and fix the referenced file.

Protocol: fresh session per prompt · no hints · record the transcript · check every code claim in the output against `references/sdk-map.md` (installed-source rule) or the cited doc path.

| File | Exercises | References |
|---|---|---|
| `concepts-evm.md` | mental model, EVM translation | concepts.md |
| `oauth-web.md` | OAuth PKCE + backend secret, scopes | identity-and-keys.md, scaffold-oauth-web |
| `payments-credit.md` | receiving, credit-once, reconciliation | payments.md, reconciliation.md, scaffold-payment-watcher |
| `blaze-duplicates.md` | ack semantics, redelivery vs ack-bug | blaze.md, gotchas.md |
| `withdrawal-fees.md` | fee branching, two-tx shape | payments.md §5, common-errors.md |
| `computer-call.md` | registration, system-call invoice flow | computer.md |
| `custody-leak.md` | leak playbook, key-grant reasoning | custody-and-ops.md |

Add a new eval file when a domain reference is added or a gotcha is newly ranked top-5.
