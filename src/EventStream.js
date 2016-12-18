const Readable = require('stream').Readable;

/**
 * An event stream is a simple wrapper around an iterator over storage documents.
 * It implements a node readable stream interface.
 */
class EventStream extends Readable {

    constructor(iterator) {
        super({ objectMode: true });
        this.iterator = iterator || { next() { return { done: true } } };
    }
/*
    append(event) {
        this.uncommittedEvents.push(event);
        this.revision++;
    }

    commit() {
        for (let event of this.uncommittedEvents) {

        }
    }
*/
    /**
     * Iterator implementation. Iterate over the stream in a `for ... of` loop.
     */
    *[Symbol.iterator]() {
        let next;
        while ((next = this.next()) !== false) {
            yield next;
        }
    }

    next() {
        let next = this.iterator.next();
        return next.done ? false : next.value.payload;
    }

    /**
     * Readable stream implementation.
     * @private
     */
    _read() {
        let next = this.next();
        this.push(next ? next : null);
    }
}

module.exports = EventStream;