# Eval: BTC withdrawal + fee explanation

## Prompt

> Withdraw 0.05 BTC from my bot's balance to bc1q... and explain the fee. The bot also holds USDT — could the fee come out of that instead?

## Passes when

- Quotes the fee live per call (`GET /safe/assets/:assetId/fees?destination=` / `client.safe.fetchFee` / Go `ReadAssetFee`) — no hardcoded numbers.
- Explains branching: fee quoted in withdrawal asset ⇒ one tx `[destination(no ghost key, type 161), MixinCashier fee, change]`; fee in chain asset (BTC here — chain of BTC is BTC, so same-asset branch; the USDT question demonstrates the two-tx branch when fee asset ≠ withdrawal asset) ⇒ withdrawal tx + fee tx referencing the withdrawal raw hash, verified and submitted as a pair.
- Destination validated per chain before build (bech32 for bc1...), tag/memo rules per chain mentioned.
- Stable trace across retries; fresh fee quote; Go `SendWithdrawal(...preferAssetFeeOverChainFee...)` slice length = branch indicator.
- Verify step: `/safe/snapshots` shows withdrawal view with external transaction id; fee snapshot to cashier present.
- Answers the USDT question correctly: fee must be in the quoted fee asset — if the quote is in BTC, you can't pay it in USDT; the branch choice is which fee the cashier quotes, not arbitrary.

## Fails when

- Hardcodes a fee, builds destination output with a ghost key, or claims fees are always paid in XIN.
- No verification step, or floats the amount anywhere.
