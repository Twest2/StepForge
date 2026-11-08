# Cloud sync stress and recovery checks

Run `node --test tests/unit/cloud-sync.test.js` for guide sync workflows,
or `npm test` for the full unit suite. The guide suite uses real GuideStores,
archives, parts manifests, screenshots and snapshot restores with an
in-memory cloud transport. It needs no account, network connection or user
library. It also runs through `bash tests/run_test.sh`.

The stress cases include four devices making simultaneous changes over five
rounds, conflicting titles, independent step edits, deletion of an untouched
step, stale listings, failed uploads and repeated convergence checks.
Assertions verify step contents, identical content hashes on every device,
and one cloud head. A single online device also merges four branches with
44-character provider IDs across multiple uploads, respecting the provider's
110-character merge-metadata limit for guides and shared settings. Existing workflows cover screenshot conflicts,
annotations, reorderings, edits during downloads/uploads and interrupted
installs.

Merge-base checks cover clock skew, merged-parent links, criss-cross
histories, deterministic ordering, missing ancestors, empty histories,
cycles, corrupted remembered bases, and integrity failures in both full
archives and parts snapshots. An ancestor is selected by graph ancestry;
timestamps and IDs break ties only between incomparable common ancestors.
Remembered bases carry a checksum over their cached entries. Older caches
without the checksum are discarded and downloaded again when possible;
when no base is available, merging conservatively treats nothing as deleted.
A corrupt downloaded base stops the guide sync before installation or
pruning.

Conflicting incoming cloud versions are copied into the receiving guide's
**Backups & snapshots** before cloud pruning can remove them. The local
pre-merge version is also snapshotted when it has unsynced changes. Snapshot
restore tests verify that every conflicting remote title remains recoverable
even after **Free up space**. These backups follow the user's local snapshot
retention policy.

A deletion received while the editor is open waits for it to close. Saved
local work moves into local Trash. Publishing a deletion queued offline
retains cloud versions with different content, preserving edits another
device uploaded meanwhile. After restoring the guide, its retained versions
are available through cloud history;
**permanently deleting** the recovery data explicitly removes all remaining
versions for that guide. Deletion markers prevent an old offline device from
recreating a deleted guide.

These checks exercise the sync protocol deterministically. They do not
certify a provider's real outage behavior or eliminate hardware failures.
Provider integration checks should additionally simulate delayed listings,
interrupted transfers and reconnects using a disposable account. Never use a
production library for destructive fault injection.
