# Minimal ref-native task-dag

**Status:** proposal for operator review
**Scope:** the normal developer-cycle task-dag data model and transitions
**Primary objective:** preserve task relationships in Git while making every
normal command validate only the proposed transition and directly adjacent
objects
**Threat boundary:** this design does not defend against a deliberately
malicious actor who already has write access to a participating repository.
It does defend against ordinary concurrency, crashes, stale writers, malformed
local input, ambiguous network outcomes, and external-service failures.

## Executive decision

Use Git as the datastore, not as an event log that must be replayed.

1. There is one recursively decomposable **Task** kind. There is no permanent
   Epic-versus-leaf type distinction.
2. Immutable Git commits hold task identity, structural relationships,
   readiness prerequisites, decomposition, and completion evidence.
3. A task's one current lifecycle ref says whether it is ready, claimed,
   waiting on children, blocked, or completed.
4. Required ref updates use appropriate Git concurrency primitives and locking
   in a semantically correct fashion. Multi-ref transitions use exact per-ref
   leases and atomic push; sequential CAS transitions are valid when their
   intermediate states are intentional, valid, and recoverable.
5. A normal command reads bounded, semantically relevant authority and the
   commits it names, including immediate parent, prerequisites, children, or
   provider/cross-repository receipts when those relationships matter.
6. Published history is assumed valid. Normal commands prove only: **if the
   observed old state is valid, this exact transition produces valid new
   state.** They never prove all history again.
7. Full scans are exceptional audit diagnostics, never part of normal command
   correctness or recovery.
8. There is no repository-wide transition journal or global writer fence.
   Historical journal refs are inert Git data: native-v2 does not read,
   validate, advance, or delete them.

This preserves the original task-dag idea—relationships live in Git objects
and refs—without the cumulative Epic Registry, a second graph authority, or a
monolithic state file.

## Goals and explicit non-goals

### Goals

- Typical developer-cycle commands finish in low single-digit wall-clock
  seconds excluding network time, with a target below one second of tooling
  overhead around the necessary Git commands.
- Work scales with the target task's immediate degree, not repository age or
  total historical task count.
- The currently published origin state is the authority and is assumed valid.
- Each accepted transition preserves validity from that valid prior state.
- Races fail cleanly without lost updates or split-brain ownership.
- Crashes and unknown push outcomes leave either the old state or the complete
  new state, with deterministic readback and safe retry.
- Cross-repository operations converge without pretending Git can provide a
  distributed transaction.
- A task that initially appears small may be decomposed later; decomposition
  is recursive and uses the same model at every level.
- GitHub issue integration is a projection/binding, not a second task model.

### Non-goals

- Detecting or resisting deliberate object/ref forgery by a repository writer.
- Revalidating all ancestors, all registry generations, or all historical task
  objects during a normal command.
- Supporting arbitrary or hypothetical Git hosting backends. The production
  contract is GitHub's atomic multi-ref receive-pack behavior.
- Immediate all-or-nothing transactions across repositories or GitHub's issue
  API.
- Maintaining a cumulative Epic Registry, a cumulative activation log that is
  replayed on reads, a second dependency-graph authority, or a monolithic
  `tasks/state` snapshot.
- Optimizing exceptional whole-repository audits to normal-command latency.
- Adopting Kubernetes/Argo-style controllers, generations, ownership systems,
  or policy machinery that are not independently required here.

## Core model

### One Task kind

A Task is an immutable commit with:

- `Task-ID`: a full stable identifier, derived from a stable operation key;
- human title and body;
- structural parent Task object, if any;
- zero or more immutable local requirement objects;
- format version.

The commit graph carries immutable relationships:

- the first parent is the structural parent Task object, when one exists;
- remaining parents are local requirement objects—either local Tasks or local
  cross-repository intent objects;
- a root Task has no structural parent.

The same relationships are named in canonical metadata so errors are local and
diagnosable; validation compares metadata to the immediate commit parents. It
does not walk beyond those parents.

`Task-ID` is the stable command/ref key with exact grammar
`v2-<64-lowercase-hex>`. The explicit `v2-` prefix makes it disjoint from v1
SHA-shaped lifecycle refs during migration. The Git object ID is the immutable
content address. Normal mutations require the full Task-ID; abbreviated IDs
are display conveniences resolved only when locally unambiguous.

There is no `Epic` bit. A Task is in exactly one of two execution forms:

- **direct:** it can be completed with implementation or operational evidence;
- **decomposed:** it is satisfied when every child in its one immutable
  decomposition manifest is complete.

A direct Task may become decomposed while claimed. Once decomposed, its child
set is immutable. If further work is discovered, decompose the relevant child.
This gives a recursive tree without changing an object's meaning in place.

### Lifecycle refs are current state, not an event log

Exactly one current lifecycle ref exists per non-compacted Task:

| Ref | Meaning | Ref target |
|---|---|---|
| `tasks/frontier/<Task-ID>` | ready to claim | Task object |
| `tasks/active/<Task-ID>` | exclusively claimed | Claim record |
| `tasks/waiting/<Task-ID>` | decomposed; waiting for children | Decomposition manifest |
| `tasks/blocked/<Task-ID>` | cannot currently advance | Block record |
| `tasks/done/<Task-ID>` | completed | Completion evidence |

Lifecycle refs are mutually exclusive. A transition atomically deletes the old
ref and creates the new ref. There is no need to ask history what state a task
is in.

State-specific record commits contain the Task-ID, Task object ID, stable
operation ID, and only fields required by that state. They directly parent the
Task object and any immediately relevant evidence. The initial frontier record
directly parents the immutable Task object. Every later lifecycle record has
its immediately preceding lifecycle record as first parent and then directly
parents the Task/evidence objects needed by that transition. This per-Task
chain is durable replay evidence; normal validation reads only its current tip
and immediate parents.

Done refs and their evidence are immutable and monotonic: ordinary commands
never repoint or delete them. That fact makes prerequisite and child-done reads
safe without impossible “compare-only” Git leases. Cancellation is omitted
from the initial model because cancelling an immutable prerequisite needs a
separate, explicit rescoping/failure-propagation policy.

### Decomposition manifest

A decomposition manifest is an immutable commit containing:

- parent Task-ID and object ID;
- stable decomposition operation ID;
- an ordered list of child Task-IDs and object IDs;
- each child's immediate readiness prerequisites;
- format version.

It directly references the parent and child Task objects. Child Task objects
directly reference their structural parent and any older sibling prerequisites.
The manifest is the one direct child map for that parent; no repository-wide
child index or `git log` search is needed.

Decomposition is one atomic transition:

1. require the caller's exact active claim;
2. create the immutable child objects and manifest locally;
3. delete `tasks/active/<parent>` at the expected claim object;
4. create `tasks/waiting/<parent>` only if absent;
5. from the same writer-fence-guarded advertisement, prove every fixed
   lifecycle namespace is absent for every proposed child Task-ID;
6. create each child lifecycle ref—frontier by default, or active for any
   explicitly requested subset of born-claimed children whose immediate
   done/admitted prerequisite refs were proven satisfied in that same
   advertisement; every born claim has its own distinct claim token;
7. push every ref update atomically.

The stable operation ID makes an identical replay recognizable. A different
manifest for an already-decomposed Task is a conflict, not an update.

### Completion evidence and recursive convergence

Direct implementation completion evidence contains:

- Task-ID and Task object ID;
- publication commit ID;
- the exact old `master` ID that is the publication commit's immediate first
  parent;
- completion operation ID and format version.

The completion evidence directly parents the Task and publication commits.

An operations-only/no-code completion is equally first-class. Its immutable
completion object directly parents the Task and stores:

- a canonical description of the steps performed and result achieved;
- explicit authorization/provenance for treating those operations as complete;
- zero or more evidence URLs plus canonical digests or captured immutable
  evidence content where available;
- logical completion ID, attempt ID, and format version.

An evidence URL is provenance, not the sole durable fact: the completion object
itself records enough description and digest/content to remain meaningful if an
external page expires. The atomic push moves `active→done`, updates the writer
fence, and creates any provider/reconciliation work refs, but does **not** move
`master` and requires no code commit.

Decomposed completion evidence contains the parent Task and decomposition
manifest plus the exact completion-evidence object for every direct child. A
parent is therefore complete from a bounded, directly inspectable proof; no
ancestry or repository-wide graph scan is necessary.

Every child completion ensures a deterministic
`tasks/reconcile/<parent-Task-ID>` ref exists, pointing to the parent's exact
decomposition manifest. Creating it is part of the same atomic push. A
sanctioned first-party `converge` command consumes one marker only when the
parent becomes done; when that parent is itself a child, the same transaction
ensures the next parent's marker and any direct provider-projection markers
exist. `converge` is the sole owner of `waiting→done`, so child completion can
never leave a stale marker for a parent it also closed. It advances **at most
one structural generation per invocation**. Any normal command touching the
Task neighbourhood may execute this same one-step convergence first. A
watchdog may accelerate queued markers, but correctness does not depend on
unpaid automation and crash recovery never depends on remembering an in-memory
queue.

This makes “parent automatically completes when all children complete” an
eventually convergent semantic without allowing one completion command to walk
an arbitrary chain to a root.

### Provider bindings without an Epic Registry

A provider binding is an immutable commit behind a provider-keyed ref:

```text
tasks/bindings/github/<sha256(owner/repo#issue)>
```

The commit contains the canonical provider key, Task-ID, Task object ID, and
binding operation ID. Creating an issue-backed root Task atomically creates
the Task lifecycle ref and absent provider-binding ref. The absent-ref lease
enforces one Task per provider key under the non-adversarial writer model.

Additional projections use additional direct binding refs. Looking up an issue
is one ref lookup and one commit read. There is no cumulative registry
snapshot, generation replay, or mapping-history validation.

The same immutable binding commit also has a reverse alias at
`tasks/bindings/by-task/<Task-ID>/<binding-key-hash>`, created atomically with
the provider-keyed ref. It is not another mapping authority: both refs must
point to the exact same immutable object. The reverse alias lets Task completion
find its directly attached projections without scanning every provider binding.

Provider side effects are outside the Git transaction. Git records a durable
intent before calling the provider; success is recorded by an immutable
receipt/binding. Unknown outcomes are reconciled by querying the stable
provider operation marker before retrying. Provider unavailability can delay
projection but cannot corrupt task authority.

GitHub does not supply a general idempotency key for issue creation. Recovery
therefore accepts exactly one exhaustive, exact marker match; multiple matches
require repair, and zero matches remain uncertain unless an authoritative
search proves absence or an operator-authorized rearm permits another create.
That exhaustive unknown-outcome recovery is exceptional and is not claimed to
meet normal command latency.

When a completed Task has provider bindings, the same completion transaction
creates deterministic `tasks/project/<provider>/<binding-key-hash>` work refs.
A sanctioned first-party projection command consumes one marker after recording
an exact durable provider receipt. External closure/comment effects therefore
remain queued across crashes without scanning done history or depending on an
unpaid watchdog.

### Cross-repository dependencies

No design can atomically push two independent repositories. A Task prerequisite
is therefore one of two immutable local requirement entries:

- a local Task requirement, satisfied by that Task's immutable done ref; or
- a cross-repository intent requirement, satisfied by an exact local admitted
  receipt ref.

Cross-repository work uses a small durable state machine:

1. the source repository records an immutable intent under a stable operation
   ref;
2. the target repository idempotently admits a Task or binding keyed by that
   operation;
3. when the target Task completes, the target publishes a parentless export
   receipt under the stable operation key; its canonical metadata names target
   repository identity, Task ID/object, exact done object, operation ID, and
   result digest;
4. the source fetches only that bounded parentless receipt and records an exact
   admitted-receipt ref locally;
5. only that local admitted receipt satisfies the source prerequisite.

Each step is independently CAS/idempotent and directly readable. A crash may
leave “intent recorded, target not admitted” or “target done, source evidence
not admitted”; both are valid, visible, and roll forward by replay. There is no
cross-repository rollback and no global graph index.

Intent-keyed export receipts and local admitted-receipt refs are immutable,
create-once, and monotonic. Ordinary commands never repoint or delete them.
They are retained indefinitely alongside done evidence unless a future
writer-paused compaction protocol proves deletion safe.

Initial cross-repository admission supports only deterministic creation of new
delegated Tasks, not arbitrary dependency edges to pre-existing remote Tasks.
Each delegation carries an immutable repository path; admission rejects a
repository already present in that path. The path is bounded by the finite set
of repository identities in the current fleet activation record and prevents
semantic cross-repository cycles without a distributed graph traversal.

## Concurrency authority

Activation remains the validated runtime-compatibility authority. Each
operation reads activation and the bounded refs relevant to its semantics,
then exact-leases every ref it updates. Operations that require a multi-ref
all-or-nothing transition use atomic push. Operation receipts support safe
replay after uncertain outcomes, and authoritative touched-ref readback
classifies success, rejection, or a conflicting result. No unrelated global
ref participates in ordinary correctness.

## Transition invariants

Every writer proves only these local facts:

1. **Runtime:** the exact current activation record explicitly permits this
   writer's exact task-dag implementation commit.
2. **Activation authority:** the validated activation permits the executing
   runtime; activation updates themselves use an exact lease.
3. **Authority:** each old ref equals the exact object ID observed before
   construction; every create asserts absence.
4. **Identity:** every new record names the same Task-ID and Task object as the
   lifecycle ref being replaced.
5. **Shape:** new objects have the expected immediate parents, canonical
   metadata, and format version.
6. **Exclusivity:** every Task-minting transition first proves all fixed
   lifecycle namespaces absent for each proposed Task-ID; every transition's
   atomic ref update leaves exactly one lifecycle state per affected Task.
7. **Readiness:** a claim is created only from frontier after all immediate
   local prerequisite done refs or admitted-receipt refs exist and match their
   immutable requirement objects. A born claim applies exactly the same check
   in the Task-creation advertisement before creating `active` directly.
8. **Ownership:** release, renewal, decomposition, block, and completion consume
   the caller's exact live claim token.
9. **Completion:** direct evidence names valid immediate implementation or
   operational evidence; decomposed evidence names the exact manifest and all
   direct child completion objects.
10. **Implementation branch safety:** for code completion, the publication
    commit's immediate first parent is the exact expected old master, and
    master moves to it in the same atomic push as task completion. Operations-
    only completion intentionally leaves master untouched.
11. **Replay:** the operation's already-achieved terminal refs either match the
    requested result exactly (success) or differ (conflict); retry never invents
    a second result.

Given valid old objects and refs, these checks are sufficient to preserve a
valid new state. None requires proving how the old state was historically
constructed.

## Minimal Git operations by command

Network fetch/push time is excluded from the tooling-overhead target. All
fetches use the caller's existing full local checkout; normal commands never
create an ephemeral clone. Each command reads only the bounded refs relevant to
its semantics.

| Command | Reads/fetches | Local work | Atomic write |
|---|---|---|---|
| create issue-backed Task | activation, one binding ref, and all fixed lifecycle namespaces for proposed Task-ID | create one Task/binding object | create binding + frontier refs, all absent-leased |
| frontier | current activation; frontier refs; immediate prerequisite done/admitted refs for candidates | parse current ref set and direct objects | none |
| context/show | fixed lifecycle namespaces for one ID and directly named Task/record | parse one neighbourhood | none |
| claim | activation; target frontier; immediate prerequisite done/admitted refs | create claim record | delete frontier at exact old; create active if absent |
| renew | activation; exact active claim | create replacement claim | replace active at exact old |
| release | activation; exact active claim | none or canonical frontier target | delete active at exact old; create frontier if absent |
| block | activation; exact active claim | create block record | active→blocked at exact old |
| unblock | activation; exact block record; immediate prerequisites | none | delete blocked at exact old; create frontier if absent |
| breakdown | activation, exact token-bound active claim, all fixed lifecycle namespaces for every proposed child ID, and immediate requirement satisfaction refs | create children + one manifest + zero or more independently readiness-proven born claims | active→waiting plus all active and frontier child refs in one atomic push |
| complete direct | activation; exact active claim; exact master; immediate prerequisites and direct reverse bindings | create publication commit with immediate first parent = master; create completion evidence | master→publication + active→done plus projection/reconcile work refs atomically |
| complete operational | activation; exact active claim; canonical result description, authorization, and optional evidence links/digests | create immutable no-code completion evidence | active→done plus projection/reconcile work refs atomically; master untouched |
| converge parent | one reconcile marker/waiting manifest; each direct child done ref; direct reverse bindings | create parent evidence | waiting→done; delete marker; ensure next-parent and provider-projection markers atomically |
| provider projection | one binding/intent ref and provider marker | create intent/receipt | absent-leased intent/binding transition |
| cross-repo admit | exact operation ref plus all fixed target lifecycle namespaces and binding refs for the proposed Task-ID | create target object/receipt | one repository's refs atomically, all Task/binding destinations absent-leased |

Mutation cost is constant except for immediate prerequisites/children and the
number of refs intentionally changed by that one operation. No command's cost
depends on master age, activation age, registry age, or total completed-task
history.

The server must advertise atomic push capability; writers fail closed if it
does not. A direct implementation is squashed or constructed as one publication
commit whose immediate first parent is the exact old master. This replaces an
unbounded “is descendant” proof with the direct check `publication^1 == old`.

### Exact ambiguous-outcome protocol

Each mutation attempt has a canonical result digest over every semantic field
and exact old/new semantic ref value. Bounded mutable inputs are read before
local construction. After an ambiguous push, one authoritative advertisement
of only the refs changed by the operation classifies the result:

- every affected ref has the exact requested new value: success;
- every affected ref has the exact old value: a new Git attempt is allowed only
  after validating current activation and repeating every bounded mutable-input
  check; completed provider effects are reconciled, not repeated;
- anything else: conflict/indeterminate, never blind retry.

Attempt-specific timestamps and tokens are fixed when the attempt is built. A
replay of that attempt reuses them. A logical completion has a stable logical
ID, but a proven master-CAS rejection followed by a rebase creates a new
attempt ID and result digest. Deterministic convergence derives its identity
from the parent manifest and exact direct child evidence.

## Claims and ordinary distributed failure

A claim record includes owner identity, host/session identity, stable claim
token, claimed-at, and expires-at. The owner renews by exact-lease replacement.
Host clocks are assumed NTP-synchronized; deliberate clock manipulation is out
of scope.

Reaping an expired claim atomically replaces that exact active ref with
frontier. If the original worker is still alive, its next renew or complete
fails the old-value lease. Thus clock error may cause wasted work, but not two
successful completions or ref corruption.

| Event | Valid durable result | Recovery |
|---|---|---|
| two claimers race | exactly one active claim | loser refreshes and selects other work |
| writer crashes before push | old state | replay operation |
| writer crashes during atomic push | old or complete new ref set | read exact refs; replay only if old |
| push succeeds but response is lost | complete new state | readback recognizes operation/result |
| master advances before completion | completion CAS fails, task remains claimed | fetch/rebase, create a new publication attempt under the same logical completion |
| claim expires during work | exact active lease is replaced | stale worker cannot complete; reconcile work under a new claim |
| provider request outcome unknown | durable intent, no trusted receipt yet | exhaustively reconcile the stable marker; never blindly retry |
| cross-repo worker dies between steps | source/target is at a named intermediate state | any agent replays the next idempotent step |
| GitHub unavailable | no authority mutation | wait/retry within bounded policy; never infer success |

## Activation and audits

Each repository has one current activation ref. Its tip is one canonical record
containing:

- activation epoch and state;
- exact allowed task-dag writer implementation commit(s), normally one;
- accepted object/ref format versions;
- the current trusted audit floor for that repository;
- digest/link for documented historical exceptions, if any.

Normal commands fetch and validate **that one record only**. They do not replay
activation history. They verify exact membership of the running task-dag
implementation commit and that the requested writer is enabled. There is no
normal-path merge-base/descendant walk.

A whole-history audit is an explicit exceptional diagnostic run while ordinary
writers are paused. Activation changes use appropriate Git concurrency
primitives and locking, with authoritative readback. Cross-repository
activation is coordinated, not falsely described as atomic. Normal commands do
not independently prove tip ancestry or revisit historical state.

## Retention and compaction

Open Tasks and their direct relationships remain reachable from lifecycle,
binding, or intent refs. Completion evidence remains under `tasks/done` while
an open local or cross-repository dependant may need to admit it.

Ref growth is a capacity concern, not a reason to put normal semantics in a
cumulative state file. Done refs are retained indefinitely in this design.
Safe compaction requires a separate reviewed closed-world protocol proving that
no future or outstanding cross-repository dependant can need deleted evidence;
this proposal deliberately does not invent that protocol. Any future
compaction is an exceptional writer-paused operation coordinated through
activation. Without such a protocol, done evidence is retained.

## Concern-by-concern design budget

The “address now?” decision below is part of the design. A concern does not
earn machinery merely because it is imaginable.

| Concern | Normal-development likelihood | Consequence if ignored | Detect/mitigate later? | Decision and complexity budget |
|---|---:|---|---|---|
| concurrent claims/writers | high | duplicate ownership or lost transition | conflicts detectable, duplicate work costly | **Address now:** exact leases + atomic ref update |
| stale local checkout | high | overwrite newer state | push rejection is cheap | **Address now:** fetch target refs + exact expected-old |
| process crash | medium/high | operation stops halfway | yes if state is durable | **Address now:** atomic push and durable intent |
| lost/ambiguous network response | medium | unsafe blind retry or false failure | yes by authoritative readback | **Address now:** stable operation ID + exact readback |
| worker abandonment | medium | permanently stuck task | yes, but dispatch stalls | **Address now:** renewable expiring claim + CAS reap |
| cross-repository partial progress | medium | dependency never converges | yes from durable intent | **Address now:** intent/admission/evidence state machine |
| provider API outage/unknown POST | medium | missing/duplicate projection | usually, via stable marker | **Address now:** Git intent first, provider reconciliation |
| serious task-dag semantics bug | rare, high impact | trusted state may be wrong | explicit audit and reviewed repair | **Address now:** pause writers and audit; no normal scan or recovery subsystem |
| activation changes during an old writer | rare, high impact | old semantics can publish after cutover | controlled by rollout coordination | **Address now:** appropriate Git concurrency primitives, locking, and authoritative readback |
| malformed local command input | common | invalid proposed object | immediately | **Address now:** strict local schema/relationship checks |
| very large direct child fanout | uncommon | one parent check becomes linear/slow | visible and decomposable | **Accept now:** O(immediate degree); encourage hierarchical decomposition |
| millions of simultaneously open refs | very unlikely currently | listings become slow | measurable before corruption | **Defer:** add an index only when observed scale requires it |
| completion-ref accumulation | certain but gradual | namespace/storage growth | measurable; safe deletion needs closed-world proof | **Retain indefinitely now;** separate future design only if needed |
| host clock skew | low with fleet NTP | premature claim reap, wasted work | leases prevent stale completion | **Accept:** operational clock assumption; no consensus clock service |
| force-push/history rewrite | exceptional/operator-controlled | floor/commit mismatch | explicit fleet pause and audit | **Do not automate:** operator-approved repair path only |
| malicious repository writer | out of scope | can forge any participating state | not reliably inside same trust domain | **Do not address** |
| SHA collision | negligible | identity ambiguity | extraordinary repo repair | **Do not address** beyond full IDs |
| arbitrary non-GitHub backend | not a production need | transition atomicity may differ | choose/qualify later if needed | **Do not abstract:** require GitHub atomic push semantics |
| Byzantine/untrusted host clocks or writers | out of scope | leases/objects can be forged | requires a different security system | **Do not address** |
| total-order global scheduler fairness | low significance | some ready tasks wait longer | operationally visible | **Do not address:** correctness needs exclusivity, not fairness consensus |
| immediate recursive root closure | low significance | parent closure lags by cheap steps | yes, deterministic reconciliation | **Do not walk:** converge one structural generation per command |
| cross-repository dependency cycle | low but plausible | permanent deadlock | visible but expensive to repair | **Address now:** only new delegated Tasks; reject repeated repository in bounded delegation path |
| uncertain provider create | medium | duplicate external issue | exact marker reconciliation may remain uncertain | **Address now:** durable intent; exhaustive recovery is exceptional; no blind retry |

## Why each retained mechanism exists

| Mechanism | Minimal requirement it satisfies | Why a simpler omission is incorrect |
|---|---|---|
| separate lifecycle refs | directly readable current state | deriving state from history reintroduces replay and ambiguity |
| immutable decomposition manifest | direct child lookup and fixed completion criterion | searching commits for children is unbounded; mutable child sets make completion race-prone |
| exact expected-old lease | compare-and-swap | “push latest” can overwrite a concurrent valid transition |
| atomic multi-ref push or sequential CAS | operation-specific state coupling | operations need either all-or-nothing publication or intentional valid recoverable intermediate states |
| stable operation identity | idempotent unknown-outcome recovery | transport failure otherwise cannot distinguish absent from already done |
| current activation record | exact runtime/semantics compatibility | running an old writer against new formats can create locally valid but semantically wrong state |
| renewable claim | crash recovery without manual force | permanent claims wedge; unleased claims permit stale completion |
| cross-repo intent + admitted evidence | durable convergence without distributed transactions | direct remote observation can disappear or be reinterpreted and is not local readiness authority |
| retained done evidence | direct prerequisite proof | deleting it forces history search or makes dependants unverifiable |
| reconciliation work ref | durable eventual parent completion | incidental future commands are not a forward-progress guarantee |
| reverse binding alias + projection ref | bounded durable provider effects | provider-key-only refs require a global reverse scan after Task completion |

Everything else must justify itself against this table before entering the
normal path.

## Command semantics in the unified model

- `task-create`: create one Task, optionally with one direct provider binding
  and optionally born claimed when its immediate prerequisites are ready in
  the same advertisement. A born claim has its own distinct token. This
  replaces “epic create.”
- `breakdown`: consume a claimed Task and replace it with one immutable
  decomposition of one or more children. Works at every depth.
- `claim`, `renew`, `release`, `block`, `unblock`: lifecycle transitions over
  the same Task kind.
- `complete`: complete a direct Task and optionally move master atomically.
- `complete-ops`: complete a direct Task with an immutable description of
  operations performed, authorization, and optional evidence links/digests;
  no code commit or master update is required.
- `converge`: move one decomposed parent from waiting to done when all direct
  children are done; durable reconcile refs queue one generation at a time.
- `frontier`: list current frontier refs whose immediate prerequisite done refs
  exist; no historical facts reconstruction.
- `context`, `deps`, `dag`: read a bounded neighbourhood by following direct
  object/ref links. A user-requested wider DAG display may recurse explicitly,
  but normal mutations do not.
- `audit`: exceptional, explicitly expensive whole-state diagnostics; never
  called implicitly by a normal command.

“Close epic” disappears as a data-model primitive. Closing an issue is a
provider projection emitted when its bound root Task's done ref appears.

## Migration strategy

All other writers remain paused while implementing this performance repair, so
the migration does not need dual-write concurrency machinery.

During bootstrap and rollout, the Rust runtime treats only IDs matching
`v2-[0-9a-f]{64}` as v2 lifecycle authority. Recognized v1-shaped refs remain
inert, read-only legacy state and are recorded as a temporary exception in the
bootstrap trusted floor. The later existing-task migration converts them and
then removes their legacy scheduling refs; v2 never dual-writes them.

### Self-hosting bootstrap order

1. Let `M` be the exact current `master` object.
2. Construct candidate Rust bootstrap implementation commit `C` locally with
   `C^1 == M`.
3. Build and run the bootstrap binary corresponding exactly to `C`.
4. Under an absent-ref lease, initialize v2 activation authorizing exact runtime
   `C`. The activation object directly parents `C` in the task-dag repository,
   making the permitted runtime durable before `master` moves.
5. Create and claim the first new v2 Task for the bootstrap implementation.
6. Complete it in one atomic transaction: `master: M→C` and `active→done`.
7. With that published v2 runtime, create an **implement the remaining v2
   command set** Task and a dependent **roll out v2 and make it the only usable
   task-dag runtime** Task.
8. **Completed:** those Tasks were implemented in order and production entry
   points now use the Rust binary exclusively.
9. **Completed:** full fleet rollout/readback and existing-v1-task migration
   finished, after which the Bash runtime was retired.

After self-bootstrap:

1. Freeze the exact current origin refs and run a whole-state audit with the
   existing trusted tool. Record v1 state as a read-only bootstrap exception;
   do not convert it yet.
2. Finish the Rust normal command set and exceptional audit/activation tools
   using v2 Tasks.
3. Verify the frozen/audited floor and publish the exact Rust runtime.
4. With writers paused, activate its exact allowed writer commit and trusted
   floor in each participating repository using per-repository leased updates
   from the exceptional fleet plan.
5. **Completed:** the Rust runtime is required everywhere and no legacy writer
   remains usable; the Bash runtime has been removed.
6. **Completed:** after full rollout/readback, current v1 Tasks were migrated
   into unified Task objects, direct bindings, decomposition manifests,
   lifecycle transitions, and directly addressable completion evidence. Old
   datastore objects remain read-only historical evidence.
7. Verify the migrated ref set against the frozen source snapshot and remove
   migrated legacy scheduling refs.
8. Finish the performance epic using activated fast commands and measure real
   wall-clock/tooling overhead.
9. Remove obsolete v0 support except explicit readers for retained legacy
   datastore objects under the separately created, currently unclaimed v0
   removal epic.

Rollback before activation is “do not advance activation.” After activation,
roll forward with a repaired runtime. Re-enabling old writers against newly
emitted objects is not safe and is not the rollback strategy.

## Performance contract

For a warm existing full checkout and excluding network latency:

- target-task reads/mutations: **<1 second tooling overhead expected**;
- frontier/open-set listing: **low single-digit seconds**, proportional only to
  currently open refs and immediate prerequisites;
- breakdown: **<1 second plus local creation/push of O(children) objects**;
- direct completion: **<1 second plus the underlying Git rebase/push work**;
- one-generation parent convergence: **<1 second plus O(direct children)**;
- no normal command creates or removes a temporary clone;
- no normal command runs unbounded `git log`, `rev-list`, merge-base walks to
  genesis, cumulative registry validation, activation-history replay, or
  whole-repository validation.

Fetching a commit can negotiate reachable objects inside Git and is not called
intrinsically O(1); the bounded semantic contract is that task-dag itself asks
only for current refs/direct objects. Parentless cross-repository export
receipts prevent a foreign repository's master history from becoming reachable
through a normal receipt fetch.

Verbose timing should report each fetch, direct-object validation, local object
construction, push, and readback to live stderr. Timing is observability, not a
cache whose correctness the transition depends on.

## Rejected alternatives

### Monolithic `tasks/state`

Rejected because it duplicates refs into a second authority, creates a hot
global CAS point, makes unrelated transitions conflict, and weakens the
Git-native relationship model. A ref→object snapshot remains useful only as
exceptional audit/migration evidence.

### Cumulative Epic Registry

Rejected because direct provider-keyed binding refs provide uniqueness and
lookup without validating every historical mapping generation. Registry
history replay caused the observed effectively quadratic runtime.

### Separate mutable dependency graph ref

Rejected because structural parents, prerequisites, and decomposition manifests
already encode the needed graph locally. A second graph must be kept in sync and
becomes another authority/hot CAS point.

### Per-command ephemeral clone

Rejected because a session already has a full local checkout. Exact ref fetches
and object reads in that checkout provide the same authority at much lower
wall-clock cost.

### Whole-history validation on every command

Rejected because it proves the wrong thing repeatedly. The operational proof is
transition validity from an assumed-valid published state; rare full audits
establish a new trusted floor when that assumption needs repair.

## Acceptance criteria for the design

The design is ready to implement when review confirms:

1. every normal lifecycle and provider/cross-repo transition maps to one atomic
   local-repository CAS or one idempotent durable step;
2. every unknown outcome has a direct authoritative readback;
3. no normal transition requires ancestry/history replay or a global mutable
   snapshot;
4. recursive decomposition and eventual parent completion cannot falsely mark
   incomplete work done;
5. master publication and task completion cannot split;
6. claim expiry cannot permit two successful owners;
7. cross-repository partial states are valid and convergent;
8. serious future semantic defects can be diagnosed by an explicit audit
   without restoring normal-path history replay;
9. each retained exception mechanism has a demonstrated normal-development
   failure mode whose significance justifies its complexity.
10. activation changes use appropriate Git concurrency primitives and locking,
    and ambiguous outcomes classify from authoritative touched-ref readback
    without blind replay.
