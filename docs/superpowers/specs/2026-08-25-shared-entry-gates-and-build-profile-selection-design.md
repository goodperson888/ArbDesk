# Shared Entry Gates and Selectable Build Profiles

## Goal

Make the existing MEXC/Polymarket entry controls reusable by every executable two-leg route while keeping venue-specific safety checks explicit. Let a GitHub Actions operator choose the packaged market profile without deleting or rewriting the existing full-platform build.

The first target is the `GATE:KALSHI` BTC 15-minute route. This change does not enable automatic Gate/Kalshi order submission; it shares manual entry gates, the help popover, and opportunity alerts only.

## Build profile selection

The Windows workflow will expose a `workflow_dispatch` choice named `market_profile`:

- `btc-gate-kalshi` (default): Gate + Kalshi, BTC 15m, route `GATE:KALSHI`.
- `btc-all`: the existing all-venue BTC 5m/15m profile.

Both choices call the same `scripts/package-profile.mjs`; the selected profile changes configuration, not application code. The output directory and uploaded artifact are derived from the selected profile. Installer filenames include the profile ID so two profiles from the same application version cannot overwrite one another in a GitHub Release.

Local `package:win`, `package:mac`, and `dist` commands keep `btc-gate-kalshi` as their default. A full build remains available with `npm run package:profile -- --profile=btc-all --target=<target>`.

## Shared entry-gate model

Introduce one route-agnostic entry-gate report with ordered checks. Each check contains:

- stable ID and user-facing label;
- pass/fail state;
- `hard` or `configurable` policy;
- optional key in `ManualExecutionConditions`;
- applicability, so a venue-specific rule is not silently applied to an unrelated route;
- a blocking reason suitable for the disabled action button.

The common evaluator receives normalized route data, requested quantity, current settings, current time, and execution readiness. It returns `allowed`, active/pass counts, the ordered checks, and the first blocking reason.

### Universal hard checks

- Quantity is positive.
- Quantity satisfies every leg's minimum order requirement (including Gate's 5 USD minimum).
- Quantity does not exceed the current executable depth.
- Estimated capital does not exceed `maxCapitalPerTrade`.
- Both market/outcome identities are present.
- Required live execution switches and credentials are ready.
- No conflicting execution is currently active.

These checks cannot be disabled from the question-mark popover.

### Configurable manual checks

- `conditionalReturn`: conditional return meets `minConditionalReturnPct`.
- `quoteFreshness`: every leg is within `maxQuoteAgeMs`.
- `expiryCutoff`: remaining time exceeds `stopBeforeExpirySeconds`.
- `settlementRisk`: MEXC/Polymarket keeps its oracle-distance check; a multi-venue route uses resolution `matchClass` and passes only when the rules are exact.
- `feeVerification`: MEXC/Polymarket keeps its verified fee check; a gross-only multi-venue route reports the fee model as unverified. A human may explicitly ignore it for a manual order, while any future automatic strategy must require it.

The existing persisted `ManualExecutionConditions` remains the single source of manual overrides for all routes. Automatic execution continues to use all applicable checks regardless of manual overrides.

## Main-process enforcement

The renderer must not be the authority for execution eligibility.

For Gate/Kalshi, the IPC handler resolves `comparisonId` against the controller's latest canonical comparison instead of trusting prices, depth, match class, or fee status supplied by the renderer. Immediately before sending the first leg, the main process builds the same entry-gate report with the latest comparison and rejects the request with the report's first blocking reason when it is not allowed.

The existing execution service retains its final transport-level validation (live switches, IDs, depth, capital, freshness, expiry) as defense in depth. No new remote preflight request is added to the click path.

## User interface

The legacy MEXC/Polymarket ticket and the multi-venue ticket both render the same `ExecutionConditionsHelp` component from a shared report.

For Gate/Kalshi:

- move the real two-leg action next to the quantity/plan section;
- place the question-mark control beside the action button;
- show the same passed/active/ignored count and switches;
- show the first blocking reason directly below a disabled button;
- keep route-specific labels, such as Gate's 5 USD minimum and exact/conditional settlement-rule match;
- retain the explicit non-atomic and recovery warning.

The button is enabled only when the shared report allows it. Manual switches change both tickets immediately because they update the same settings object.

## Opportunity selection and sound

The ready-candidate selector will accept both:

- executable legacy MEXC/Polymarket comparisons; and
- manually executable multi-venue comparisons whose shared entry-gate report passes for the current planned quantity.

Fixed table ordering remains unchanged. The best eligible opportunity may be selected without reordering rows.

The existing sound settings (`opportunitySoundEnabled`, volume, and cooldown) become route-independent. A sound is played only when the best candidate transitions from ineligible to eligible, or a different best candidate becomes eligible after the global cooldown. Snapshot refreshes with unchanged eligibility do not replay the sound.

## Automatic execution boundary

This change deliberately does not include Gate/Kalshi in `autoOpenEnabled`. The existing automatic executor remains limited to its mature MEXC/Polymarket path. Gate/Kalshi can be added later only after its fill readback, partial-fill alignment, and recovery behavior have separate automatic-execution tests.

## Error handling

- Missing or unknown workflow profile fails the build before Electron packaging.
- A comparison that disappears or changes identity between render and click is rejected before the first leg.
- A stale or changed quote is reported as a normal entry-gate block, not a transport failure.
- Disabled configurable checks are clearly marked as ignored; hard checks never present a switch.
- Existing recovery behavior remains unchanged once the first leg has actually been submitted.

## Testing

- Profile workflow/config tests cover both selectable profiles and profile-specific artifact paths.
- Pure entry-gate tests cover universal hard checks, per-route applicability, manual overrides, and the rule that automatic evaluation ignores overrides.
- Gate/Kalshi tests cover the 5 USD Gate minimum, depth, capital, freshness, expiry, gross-only fee warning, and conditional settlement mismatch.
- IPC/service tests prove canonical comparison data is used and that a changed/stale comparison is rejected before an adapter is called.
- Renderer tests cover the multi-venue question mark, disabled reason, shared switches, and eligibility transition used by the sound selector.
- Full unit tests, TypeScript build, workflow YAML parsing, and `git diff --check` are required before completion.
