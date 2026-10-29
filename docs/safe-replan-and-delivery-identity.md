# Safe replanning and delivery identity

Implementation branch: `feat/product-planning-foundations`. Not activated in production.

## Choosing a result

A completed solve creates a saved candidate. The previously displayed plan stays open. Compare the two results, then choose **Keep previous** or **Use candidate**. An incomplete candidate requires explicit acknowledgement. Failed constraint evidence or inconsistent coverage cannot be waived this way.

Selection is separate from approval. Selecting a Draft never approves it, and an earlier plan's approval is not transferred to another result. A previous result from an earlier scenario revision remains historical; keeping it does not make it current or feasible under later edits.

The stateful API uses `POST /api/scenarios/:id/select-plan`, an `If-Match` planning revision and a separate `selectionVersion`. Concurrent choices across replicas serialize on the scenario row; one succeeds and the other receives 409. The authoritative membership is checked again in the transaction. Selection does not advance the planning revision. Both saved result records remain available.

The browser retains a pending result across reloads using the existing active-job recovery mechanism. After adoption, workspace restoration follows the server-selected result. Navigating away clears the local pending panel; the candidate remains available in Plans.

## Identity

The authoritative delivery key is the immutable request-artifact checksum plus `requestId`. An order number is a display/business reference and may repeat. Pins, forbids, stop sequences, drag/drop, bulk selection, reorder previews, comparisons and exports carry delivery IDs. Scenario edit bundles preserve the checksum and IDs.

Legacy references remain usable when unique. Ambiguous historical references fail closed and must be explicitly reconciled; the application does not pick the last matching delivery. Dataset-bound edits cannot be reused with another artifact checksum.

CSV exports append `request_id` and `dataset_sha256` before handoff metadata, preserving the original leading columns. JSON handoffs include the dataset checksum and individual request IDs where recorded. Historical exports do not manufacture missing identity.

Comparisons suppress verified improvement claims when delivery scope, dataset identity, tariff or policy cannot be established, or when previously served deliveries are lost—even if served counts are equal. Numeric deltas remain available where their units and tariff model are comparable. Staged previews do not claim verified savings.

## Native warm-start limits

The stateful worker can supply the existing native `initial_routes` interface with an independently checked current incumbent. The plan must match the scenario revision, pinned dataset, trusted fleet/tariff settings and constraints. Ineligible incumbents are not seeded; provenance records whether a requested warm start was used.

These routes are construction hints, including flattened multi-trip sequences. They are not a guarantee that Surge retains an incumbent verbatim or produces a better result. HGS/population configuration is unchanged. Explicit candidate selection protects the dispatcher from silently replacing a better saved result.

## Validation

Unit coverage includes duplicate references, equal-count service swaps, namespace mismatch, import/export identity, locks, compact native IDs and warm-start eligibility. Two independent APIs exercise competing selections, stale revisions, incomplete-candidate acknowledgement and preservation of Draft status. The isolated production-image Playwright suite exercises manual decisions, native replanning, comparison and candidate adoption with synthetic inputs. Private Gyermelyi and geographic validation must be reported separately when executed.

No database migration is required for this milestone; scenario metadata is additive. Production deployment remains a separate action.
