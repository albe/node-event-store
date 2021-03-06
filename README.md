![event-storage](logo/color.png)

[![build](https://github.com/albe/node-event-storage/workflows/build/badge.svg)](https://github.com/albe/node-event-storage/actions)
[![npm version](https://badge.fury.io/js/event-storage.svg)](https://badge.fury.io/js/event-storage)
[![Code Climate](https://codeclimate.com/github/albe/node-event-storage/badges/gpa.svg)](https://codeclimate.com/github/albe/node-event-storage)
[![Coverage Status](https://coveralls.io/repos/github/albe/node-event-storage/badge.svg?branch=main)](https://coveralls.io/github/albe/node-event-storage?branch=main)
[![Code documentation](https://inch-ci.org/github/albe/node-event-storage.svg?branch=main)](https://inch-ci.org/github/albe/node-event-storage)

# node-event-storage

An optimized embedded event store for modern node.js, written in ES6.

> **Disclaimer:** This is currently under heavy development and not production ready. See [issues/29](https://github.com/albe/node-event-storage/issues/29) for more information.

# Contents

- [Why?](#why)
- [Use cases](#use-cases)
- [Design goals](#design-goals)
- [Event storage specifics](#event-storage-and-its-specifics)
- [Installation](#installation)
- [Usage](#usage)
  * [Creating additional streams](#creating-additional-streams)
  * [Optimistic concurrency](#optimistic-concurrency)
  * [Reading streams](#reading-streams)
    * [Joining streams](#joining-streams)
    * [Event metadata](#event-metadata)
  * [Consumers](#consumers)
    * [Exactly-once](#exactly-once-semantics)
    * [Consumer state](#consumer-state)
    * [Consistency guards (a.k.a. "Aggregates")](#consistency-guards-aka-aggregates)
  * [Read-Only](#read-only)
- [Implementation details](#implementation-details)
  * [ACID](#acid)
  * [Global order](#global-order)
  * [Event streams](#event-streams)
  * [Partitioning](#partitioning)
  * [Custom serialization](#custom-serialization)
  * [Compression](#compression)
  * [Security](#security)

## Why?

There is currently only a single embedded event store implementation for node/javascript, namely https://github.com/adrai/node-eventstore

It is a nice project, but has a few drawbacks though:

  - its API is fully based around Event Streams, so in order to commit a new event the full existing Event Stream needs to be
      retrieved first. This makes it unfit for client application scenarios that frequently restart the application.
  - it has backends for quite a few existing databases (TingoDB, NeDB, MongoDB, ...), but none of them are optimized for event storage needs
  - the embeddable storage backends (TingoDB, NeDB) do not persist indexes and hence are very slow on initial load
  - it stores event publishing meta information in the events, so it does updates to event data
  - events are fixed onto one stream and it's not possible to create multiple streams that partially contain
      the same events. This makes creating projections hard and/or slow.

## Use cases

Event sourced client applications running on node.js (electron, node-webkit, etc.).
Small event sourced single-server applications that want to get near-optimal write performance.
Using it as queryable log storage.

## Design goals

- single node scalability
  * opening/writing to an existing store with millions of events should be as fast as opening/writing an empty store
  * write performance should not be constrained by locking or distributed transaction costs, i.e. single-writer (at least per transaction boundary = stream), so no horizontal write scaling
  * read performance should be optimized for sequential read-forward style reads starting at arbitrary position
  * reads should be scalable to as many readers as necessary (but typically one reader per projection)
  * it should be possible to create high number (thousands) of streams without high resource (memory,cpu) usage
  * re-reading (replaying) an arbitrary stream should be optimized for and cost no more than visiting every document in that stream (no full database scan)
- consistency
  * writes to a single stream need to be able to guarantee consistency (i.e. every write happens only as of the state immediately before that write)
  * reads from a stream need to be consistent every time, i.e. repeatable read isolation (guaranteed order, read-committed for read-only but read-uncommitted/read your own writes for writers)
- simplicity
  * the architecture and design should be straight-forward, not more complex than dictated by the goals
  * creating new streams (from existing data) should be easily doable with language-level methods

### Non-Goals

- distributed storage/distributed transactions
- therefore: no network API
- cross-stream transactions
- arbitrary querying capabilities - only range scans per stream

## Event-Storage and it's specifics

The thing that makes event storages stand out (and makes them simpler and more performant), is that they
have no concept of overwriting or deleting data. They are purely append-only storages, and the only querying is
sequential (range) reading (possibly with some filtering applied): 

This means a couple of things:

  - no write-ahead log or transaction log required - the storage itself is the transaction log!
  - therefore writes are as fast as they can get, but you only can have a single writer (without implementing complex distributed log with RAFT or Paxos)
  - durability comes for free (in complexity) if write caches are avoided
  - reads and writes can happen lock-free, reads don't block writes and are always consistent (natural MVCC)
  - indexes are append-only and hence gain the same benefits
  - since only sequential reading is needed, indexes are simple file position lists - no fancy B+-Tree/fractal tree required
  - indexes are therefore pretty cheap and can be created in high numbers
  - creating backups is easily doable with rsync or by creating file copies on the fly

Using any SQL/NoSQL database for storing events therefore is sub-optimal, as those databases do a lot of work on
top which is simply not needed. Write and read performance suffer.

## Installation

`npm install event-storage`

## Run Tests

`npm test`

## Usage

```javascript
const EventStore = require('event-storage');

const eventstore = new EventStore('my-event-store', { storageDirectory: './data' });
eventstore.on('ready', () => {
    const streamVersion = eventstore.getStreamVersion('my-stream');
    //...
    eventstore.commit('my-stream', [{ foo: 'bar' }], streamVersion, () => {
        //...
    });

    let stream = eventstore.getEventStream('my-stream');
    for (let event of stream) {
        //...
    }
});
```

The `streamVersion` is needed if you do any async work in between the `getStreamVersion` and `commit`, that
potentially involves other commits to the same stream. See [Optimistic Concurrency](#optimistic-concurrency).

### Creating additional streams

Create additional streams that contain only part of another stream, or even a combination of events of other streams.

```javascript
//...
let myProjectionStream = eventstore.createStream('my-projection-stream', (event) => ['FooHappened', 'BarHappened'].includes(event.type));

for (let event of myProjectionStream) {
    //...
}
```

### Optimistic concurrency

Optimistic concurrency control is required when multiple sources generate events concurrently.

> Note that having the producer of events behind a HTTP interface automatically implies concurrent operation.

To handle those cases but still guarantee all those producers can have their own consistent view of the current state,
you need to track the last `streamVersion` the producer was at when he generated the event, then send that as `expectedVersion`
with the commit.

```javascript
const model = new MyConsistencyModel();
const stream = eventstore.getEventStream('my-stream');
stream.forEach((event, metadata) => {
    model.apply(event);
});
const expectedVersion = stream.version;
// Provide model state and expectedVersion to some state change API or UI that returns a command
//...
// generate new events from the current model, by applying an incoming command
const events = model.handle(command.payload);
try {
    // The expectedVersion is supposed to be given back through the command
    eventstore.commit('my-stream', events, command.expectedVersion, () => {
        //...
    });
} catch (e) {
    if (e instanceof EventStore.OptimisticConcurrencyError) {
        //...
        // Reattempt command / resolve conflict
    }
}
```

Where `expectedVersion` is either `EventStore.ExpectedVersion.Any` (no optimistic concurrency check, the default),
`EventStore.ExpectedVersion.EmptyStream` or any version number > 0 that the stream is expected to be at.
It will throw an OptimisticConcurrencyError if the given stream version does not match the expected.
In that case you should either signal that back to the upstream source, or replay state and reattempt application
of the command.

### Reading streams

Of course any functional system will not only write to the storage, but also read back the events and do something meaningful with them.
The common case is a projection/read model, or a process manager (which is technically a projection that emits new events), but could also
be for just skimming through the events for migrating/upgrading data or just showing a history table.
For this you can just get a hold of the event stream you want to read, and iterate it. The EventStream is an [Iterable](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols)!
Apart from that, you can also specify the exact version range you want to iterate at the time of retrieving the stream. With this it is also
possible to iterate the stream in reverse, by specifying a lower `max` than `min` revision.

```javascript
const stream0 = eventstore.getEventStream('my-stream', 1, -1); // all events from the start (#1) up to the last (-1 equals the last version)
const stream1 = eventstore.getEventStream('my-stream', 1, 50); // all events from the start (#1) up to event #50, hence 50 events in total
const stream2 = eventstore.getEventStream('my-stream', 10, -10); // the events starting from #10 up to the 10th last event
const stream3 = eventstore.getEventStream('my-stream', -10, -1); // get the last ten events starting from the earliest
const stream4 = eventstore.getEventStream('my-stream', -1, -10); // get the last ten events starting from the last in reverse order

for (let event of stream{x}) {
   //...
}
```

Since version 0.9 the EventStream API also allows specifying the version range with a natural language like this:
```javascript
const allBackwards  = eventstore.getEventStream('my-stream').backwards();
                    // OR eventstore.getEventStream('my-stream').fromEnd().toStart();
const first10       = eventstore.getEventStream('my-stream').first(10);
                    // OR eventstore.getEventStream('my-stream').fromStart().forwards(10);
const last10        = eventstore.getEventStream('my-stream').last(10);
                    // OR eventstore.getEventStream('my-stream').from(-10).forwards(10);
const last10reverse = eventstore.getEventStream('my-stream').last(10).backwards();
                    // OR eventstore.getEventStream('my-stream').fromEnd().backwards(10);
const after15       = eventstore.getEventStream('my-stream').from(16).toEnd();
const before10      = eventstore.getEventStream('my-stream').from(10).toStart();
                    // OR eventstore.getEventStream('my-stream').fromStart().until(10).backwards();
const middle10      = eventstore.getEventStream('my-stream').from(5).forwards(10);
                    // OR eventstore.getEventStream('my-stream').from(5).following(10);
                    // OR eventstore.getEventStream('my-stream').from(14).previous(10).forwards();
const from9to5      = eventstore.getEventStream('my-stream').from(9).until(5);
                    // OR eventstore.getEventStream('my-stream').from(5).until(9).backwards();
```

**Note**
> If a new event is appended right after the `getEventStream()` (including range selection methods) call, but before iterating, this event will **not** be included in the iteration.
> This is due to the revision boundary being fixed at the time of getting the stream reference. In some cases this might be unwanted, but those cases are
> probably better covered by [consumers](#consumers).

#### Joining streams

Sometimes you might want to iterate over events from multiple streams in the order they were appended to the respective streams. In that case the
`fromStreams(string transientStreamName, array streamNames, [number minRevision, [number maxRevision]])` method will do what you want.
It will return an instance of `EventStream` (`JoinEventStream` actually) that will iterate the events of all streams specified in their global insertion order.
You can also reverse the order by specifying a lower `max` than `min` revision.
The result of this iteration will not be persisted and is not applicable to [consumers](#consumers), so if you intend to more frequently work with the join of
those streams, another approach would be to create a completely new stream that will match all events that belong to the streams you want to join.

#### Stream categories

Similar to EventStoreDB (and other), event-storage allows categorizing streams by naming convention.
This is useful when e.g. needing to iterate all events that belong to a single model class, rather than instance.
In this case, you name the streams for the instances as the class name followed by the identity of the instance, e.g. `user-123`, `user-456`, etc.
If you then want to iterate all users' events, you would need to join the streams of all users and for convenience you can do this with
the method `getEventStreamForCategory(categoryName, minRevision, maxRevision)`. This will find all streams whose name starts with the given
`categoryName` followed by a dash and return a [joined stream](#joining-streams) over those. If you already created a dedicated stream for this
category manually, this stream will be returned.

```javascript
eventstore.commit('user-' + user.id, [new UserRegistered(user.id, user.email)]);
//...
const allUsersStream = eventstore.getEventStreamForCategory('user');
```

#### Event metadata

In case you also need access to the storage level meta information, the iterable approach will not suffice. For those cases the `forEach((event, metadata, streamName) callback)`
method will give you everything you need.
```javascript
const stream = eventstore.getEventStream('my-stream');
stream.forEach((event, metadata, streamName) => {
   // metadata is an object of the form { commitId, committedAt, commitVersion, streamVersion } combined with any additional metadata you provide in the commit call.
   // commitId is a unique Id for the whole commit, committedAt the milliseconds timestamp when the commit happened,
   // commitVersion is the sequence number for the event within the commit and streamVersion the version of the event within the stream
   eventstore.commit('my-new-stream', [event], metadata);
});
```
This is primarily useful for low-level work, like rewriting streams.

### Consumers

Consumers are durable event-driven listeners on event streams. From a nodejs perspective they are `stream.Readable`s. They provide
at-least-once delivery guarantees, meaning they receive each event in the stream at least once. An event may be delivered twice if
the program crashed during the handling of an event, since the current position will only be persisted *afterwards*.
As of version 0.6 the `setState()` method allows opting into [exactly-once](#exactly-once-semantics) processing.

```javascript
let myConsumer = eventstore.getConsumer('my-stream', 'my-stream-consumer1');
myConsumer.on('data', event => {
    // do something with event, but be sure to de-duplicate or have idempotent handling
});
```

Since a consumer is always bound to a specific stream, you need to create a stream for the specific consumer first,
if it needs to listen to events from different [write-streams](#event-streams).

**Note**
> The consuming of events will start as soon as a handler for the `data` event is registered and suspended
> when the last listener is removed.

As soon as the consumer has caught up the stream, it will emit a `caught-up` event.

#### Exactly-Once semantics

Since version 0.6 the consumers can persist their state (a simple JSON object), which allows for achieving
exactly-once processing semantics relatively easy. What this means is, that the state of the consumer will
always reflect the state of having each event processed exactly once, because if persisting the state fails,
the position will also not be updated and vice versa.

```javascript
let myConsumer = eventstore.getConsumer('my-stream', 'my-stream-consumer1');
myConsumer.on('data', event => {
    const newState = { ...myConsumer.state, projectedValue: myConsumer.state.projectedValue + event.someValue };
    myConsumer.setState(newState);
});
```

This is very useful for projecting some data out of a stream with exactly-once processing without a lot of effort.
Whenever the state has been persisted, the consumer will also emit a `persisted` event.

**Note**
> Never mutate the consumers `state` property directly and only use the `setState` method **inside** the `data` handler.
> Since version 0.8 mutating is prevented by freezing the state object.

The reason why this works is, that conceptually the state update and the position update happens within a single
transaction. So anything you can wrap inside a transaction with storing the position yields exactly-once semantics.
However, for example sending an email exactly once for every event is not achievable with this, because you can't
wrap a transaction around sending an e-mail and persisting the consumer position in a local file easily.

#### Consumer state

Since version 0.8 a consumer can set an initial state and update it's state via a function that receives the current state as argument.
That way it becomes much easier to write reusable state calculation functions.

```javascript
const myConsumer = eventstore.getConsumer('my-stream', 'my-stream-consumer1', { someValue: 0, someOtherValue: true });
myConsumer.on('data', event => {
    myConsumer.setState(state => ({ ...state, someValue: state.someValue + event.someValueDiff }));
});
```

Also, since that version the consumer can be reset, to force it to reprocess all (or a subset) of the events.

```javascript
myConsumer.reset({ someValue: 1 }, 10);
```
This will restart the consumer with an inital state of `someValue = 1` and reprocess starting from position 10 in the stream.

#### Consistency guards (a.k.a. "Aggregates")

Consistency guards, or more famously yet misleadingly called "Aggregates" in event sourcing can be built with the semantics
that a `Consumer` provides.
One example for the code is shown here:

```javascript
const myConsistencyGuard = eventstore.getConsumer('my-guard-stream', 'my-guard-uuid');
// The guard's apply event method, which will update the internal state. Since the consumer is running in the same process
// as the writing eventstore, this is effectively synchronous (invoked on next node event loop).
// This should only contain the data necessary to make the decisions in validateCommand()
myConsistencyGuard.apply = function(event) {
    this.setState(state => ({ ...state, someValue: calculateNewValue(state.someValue, event) }));
};
// You could also just use a lambda here, but the apply/handle separation is a well known paradigm when building "Aggregates"
myConsistencyGuard.on('data', myConsistencyGuard.apply);
// The command handling method that builds new events (this makes the guard easily testable).
// This contains (only) your business rules fulfilling some (hard) constraints. It only returns the events
// that should be emitted from handling the command.
myConsistencyGuard.handle = function(command) {
    // Should throw an Error if the command is rejected based on the current state
    validateCommand(command, this.state);
    return [new MyDomainEvent(command), ...];
};

// This is probably a HTTP handler method like express' app.post('my/guard/uri', ...) or invoked from there
function myCommandHandler(command) {
    // Notice how the guard just becomes some arbitrary event emitter - in a lot of cases you don't need a guard at all, e.g. if you only do Event = CommandHappened
    eventstore.commit(myConsistencyGuard.streamName, myConsistencyGuard.handle(command), command.position || myConsistencyGuard.position);
}
```

So how does this work? First, the guard is basically a consumer of its own stream. Since a consumer provides
[exactly-once](#exactly-once-semantics) processing guarantees when using `setState()`, we are always sure that the guard's state exactly reflects
the state after processing all events once. Therefore, the handle method can safely make decisions based on that assumption
and reject commands that do not fit the current state of the guard. If two requests come in in parallel, the optimistic concurrency
check of the commit will prevent the second attempt from persisting those events. For multi-user handling, the command should
already carry the last known version of the guard that the user made a decision on. Otherwise, the guard's own position makes sure
that only events directly following the previous state are committed.

**Note**
> This implementation of a consistency guard already implements snapshotting automatically, which means that restarting the process
> does not require rebuilding the state from all previous events. If you want to control how often the guard's state is snapshotted,
> you can specify a second argument to the `setState()` method that should be true when a snapshot should be created and false otherwise,
> e.g. `this.position % 20 === 0`. Note that this is only needed for very high frequency guards/streams, in order to reduce IO.

### Read-Only

The `EventStore` can also be opened in a readonly mode since 0.7, by specifying the constructor option `readOnly: true`.
In this mode, any writes to the store will be prevented, while all reads and consumers work as normal. The read-only storage
will watch the files that back it and automatically update internal state on changes, so the reader is asynchronously fully
consistent to the writer state. You can open as many readers as needed, and the main use case is to use it for consumers running
in a different process than the writer. This way, you can have different processes create projections from the events for
different use cases and serve their state out to other systems, e.g. through an HTTP interface or whatever deems useful.

```javascript
const EventStore = require('event-storage');

const eventstore = new EventStore('my-event-store', { storageDirectory: './data', readOnly: true });
eventstore.on('ready', () => {
    let myConsumer = eventstore.getConsumer('my-stream', 'my-stream-consumer1');
    myConsumer.on('data', event => {
        const newState = { ...myConsumer.state, projectedValue: myConsumer.state.projectedValue + event.someValue };
        myConsumer.setState(newState);
    });
});
```

In theory, it would even be possible with this, to scale the storage to multiple machines, if they are all backed by a common
file system. The biggest issue preventing this is, that the nodejs file watcher needs to work on that filesystem.
See https://nodejs.org/api/fs.html#fs_availability for more information.
Also, you could rsync the files that back the storage to another machine and have a read-only instance running on that.
See https://linux.die.net/man/1/rsync and the `--append` option.

## Implementation details

### ACID

> Note: All following explanations talk about a single transaction boundary, which is a single write-stream, AKA a storage partition.

The storage engine is not strictly designed to follow ACID semantics. However, it has following properties:

#### Atomicity

A single document write is guaranteed to be atomic. Unless specifically configured, atomicity spreads to all subsequent
writes until the write buffer is flushed, which happens either if the current document doesn't fully fit into the write
buffer or on the next node event loop.
This can be (ab)used to create a reduced form of transactional behaviour: All writes that happen within a single event loop
and still fit into the write buffer will all happen together or not at all.
If strict atomicity for single documents is required, you can configure the option `maxWriteBufferDocuments` to 1, which
leads to every single document being flushed directly.

#### Consistency

Since the storage is append-only, consistency is automatically guaranteed for all successful writes. Writes that fail in
the middle, e.g. because the machine crashes before the full write buffer is flushed, will lead to a torn write. This is
a partial invalid write. To recover from such a state, the storage will detect torn writes and truncate them when an existing
lock is reclaimed. This can be done by instantiating the store with the following option:

```javascript
const eventstore = new EventStore('my-event-store', { storageConfig: { lock: EventStore.LOCK_RECLAIM } });
```

Note that this option will effectively bypass the lock that prevents multiple instances from being created, so you should
not use this carelessly. Having multiple instances write to the same files will lead to inconsistent data that can not be
easily recovered from.

#### Isolation

The storage is supposed to only work with a single writer, therefore writes do not influence each other obviously. The single
writer is only guaranteed with a simple lock-directory mechanic, which works on NFS. This is of course not a hard guarantee, just
a helper to prevent accidentally opening two writers.
Reads are guaranteed to be isolated due to the append-only nature and a read only ever seeing writes that have finished
(not necessarily flushed - i.e. Dirty Reads) at the point of the read. In a read-only instance, dirty reads are technically
impossible, because the reader has no access to the unfinished writes. Multiple reads can happen without blocking writes.

If Dirty Reads are not wanted, they can be disabled with the storage configuration option `dirtyReads` set to false. That
way you will only ever be able to read back documents that where flushed to disk, even on writers. Note though, that this should
only be done with in-memory models that keep their own (uncommitted) state, or else you might suffer from inconsistency.

There are no lost updates due to the append-only nature. Phantom reads can be prevented by specifying the `maxRevision` for 
streams explicitly (MVCC). All reads are repeatable, as long as no manual truncation happens.

#### Durability

Durability is not strictly guaranteed due to the used write buffering and flushes not being synced to disk by default.
All writes happening within a single node event loop and fitting into the write buffer can be lost on application crash.
Even after flush, the OS and/or disk write buffers can still limit durability guarantees.
This is a trade-off made for increased write performance and can be more finely configured to needs.
The write buffer behaviour can be configured with the already mentioned `maxWriteBufferDocuments` and `writeBufferSize`
options. For strict durability, you can set the option `syncOnFlush` which will sync all flushes to disk before finishing,
but comes at a very high performance penalty of course.

Note: If there are any misconceptions on my side to the ACID semantics, let me know.

### Global order

Currently, the `storage` guarantees a consistent global ordering on all events by managing a global primary index. This makes
sure that streams that are made up of multiple write-streams will stay consistent when re-reading all events. This has some
issues though, like not being able to consistently reindex a storage, which is discussed in https://github.com/albe/node-event-storage/issues/24.

Since version 0.7 the storage also stores a monotonic clock stamp and an external sequence number together with the document.
This way, a consistent global order can also be reconsituted without a global index. In a later version, the global index might
therefore be removed and reindexing a storage be possible, which allows to rebuild a consistent state after a destructive crash.

### Event Streams

There are two slightly different concepts of Event Streams:

  - A write stream is a single identifier that an event/document is assigned to on write (see Partitioning). It is therefore
    a physical separation of the events that happens on write. An event written to a specific write stream can not be removed
    from it, it can only be linked to from other additional (read) streams.

  - A read stream is an ordered sequence in which specific events are iterated when reading. Every write stream automatically
    creates a read stream that will iterate the events in the order they were written to that stream. Additional read streams
    can be created that possibly even sequence events from multiple write streams. Such read streams can be deleted without
    problem, since they will not actually delete the events, but just the specific iteration sequence.

An Event Stream is implemented as an iterator over an storage index. It is therefore limited to iterating the events at
the point the Event Stream was retrieved, but can be limited to a specific range of events, denoted by min/max revision.
It implements the node `ReadableStream` interface.

### Partitioning

By default, the Event Store is partitioned on (write) streams, so every unique stream name is written to a separate file.
This has several consequences:

  - subsequent reads from a single write stream are faster, because the events share more locality
  - every write stream has it's own write and read buffer, hence interleaved writes/reads will not trash the buffers
  - since writes are buffered, only writes within a single write stream will be flushed together, hence "transactionality" is not spread over streams
  - the amount of write streams is limited by the amount of files the filesystem can handle inside a single folder
  - if hard disk is configured for file based RAID, this will most likely lead to unbalanced load

If required, the partitioning behaviour can be configured with the `partitioner` option, which is a method with following signature:
`(string:document, number:sequenceNumber) -> string:partitionName`
i.e. it maps a document and it's sequence number to a partition name. That way you could for example easily distribute all writes
equally among a fixed number of arbitrary partitions by doing `(document, sequenceNumber) => 'partition-' + (sequenceNumber % maxPartitions)`.
This is not recommended in the generic case though, since it contradicts the consistency boundary that a single stream should give.
Many databases partition the data into Chunks (striding) of a fixed size, which helps with disk performance especially in RAID setups.
However, since SSDs become more the standard, the benefit of chunking data is becoming more limited. It does help with incremental
backup strategies, or for use cases where old data needs to be archived or even deleted. For those cases, the partitioner could look
like `(document, sequenceNumber) -> 'partition' + (sequenceNumber / documentsPerChunk) >> 0`, which will write documents into an ever
increasing number of partitions. Or you partition by the document timestamp, which for an `EventStore` document could be taken from the `committedAt` field, which is a javascript timestamp. Optimally, you might want to make sure a commit is not spread among partitions though, so those partitioners are not fool-proof.

### Custom Serialization

By default, the serialization will be achieved through `JSON.stringify` and `JSON.parse`. Those are plenty fast on recent nodejs 
versions, but JSON serialization takes more space than more optimized formats. You could use some other library, like `@msgpack/msgpack`
to have performant, but space-safing data format. In benchmarks, `@msgpack/msgpack` even turns out faster than `JSON.parse` for
deserialization and pretty much on par with `JSON.stringify` for serialization. The drawback is that the storage files are no longer
human readable.


```javascript
const { encode, decode } = require('@msgpack/msgpack');
const eventstore = new EventStore('my-event-store', {
	storageDirectory: './data',
	storageConfig: {
		serializer: {
			serialize: (doc) => {
				const encoded = encode(doc);
				return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength).toString('binary');
			},
			deserialize: (string) => {
				return decode(Buffer.from(string, 'binary'));
			}
		}
	}
});
```

### Compression

To apply compression on the storage level, the `serializer` option of the Storage can be used.

For example to use LZ4:

```javascript
const lz4 = require('lz4');
const eventstore = new EventStore('my-event-store', {
	storageDirectory: './data',
	storageConfig: {
		serializer: {
			serialize: (doc) => {
				return lz4.encode(Buffer.from(JSON.stringify(doc))).toString('binary');
			},
			deserialize: (string) => {
				return JSON.parse(lz4.decode(Buffer.from(string, 'binary')));
			}
		}
	}
});
```

Since compression works on a per document level, compression efficiency is reduced. This is currently necessary
to allow fully random access of single documents without having to read a large block before.
If available, use a dictionary for the compression library and fill it with common words that describe
your event/document schema and the following terms:

- "metadata":{"commitId":
- ,"committedAt":
- ,"commitVersion":
- ,"commitSize":
- ,"streamVersion":

### Security

When specifying a matcher function for streams/indexes those matcher functions will be serialized into the index
file and be `eval`'d on later loading for convenience to not having to specify the matcher when reopening.
In order to prevent some malicious attacker from executing arbitrary code in your application by altering an index
file, the matcher function gets fingerprinted with an HMAC.
This HMAC is calculated with a secret that you should specify with the `hmacSecret` option of the storage
configuration.

Currently the `hmacSecret` is an optional parameter defaulting to an empty string, which is insecure, so always
specify an own unique random secret for this in production.

Alternatively you should always explicitly specify your matchers when opening an existing index, since that will
check the specified matcher matches the one in the index file.
