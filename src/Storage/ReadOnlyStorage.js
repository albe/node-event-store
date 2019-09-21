const fs = require('fs');
const ReadableStorage = require('./ReadableStorage');
const ReadablePartition = require('../Partition/ReadablePartition');

/**
 * An append-only storage with highly performant positional range scans.
 * It's highly optimized for an event-store and hence does not support compaction or data-rewrite, nor any querying
 */
class ReadOnlyStorage extends ReadableStorage {

    /**
     * @inheritdoc
     */
    constructor(storageName = 'storage', config = {}) {
        super(storageName, config);
    }

    /**
     * Open the storage and indexes and create read and write buffers eagerly.
     * Will emit an 'opened' event if finished.
     *
     * @api
     * @returns {boolean}
     */
    open() {
        if (!this.watcher) {
            this.watcher = fs.watch(this.dataDirectory, {persistent: false}, this.onDirectoryContentsChanged.bind(this));
        }
        return super.open();
    }

    /**
     * @private
     * @param {string} eventType
     * @param {string} filename
     */
    onDirectoryContentsChanged(eventType, filename) {
        if (eventType === 'change') {
            return;
        }

        if (filename.substr(-7) === '.branch') {
            return;
        }
        // Ignore files not belonging to this storage
        if (filename.substr(0, this.storageFile.length) !== this.storageFile) {
            return;
        }

        if (filename.substr(-6) === '.index') {
            // New indexes are not automatically opened in the reader
            this.emit('index-created', filename);
            return;
        }

        const partitionId = ReadablePartition.idFor(filename);
        if (!this.partitions[partitionId]) {
            const partition = this.createPartition(filename, this.partitionConfig);
            this.partitions[partition.id] = partition;
            this.emit('partition-created', partition.id);
        }
    }

    /**
     * Close the storage and frees up all resources.
     * Will emit a 'closed' event when finished.
     *
     * @api
     * @returns void
     */
    close() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        super.close();
    }

    /**
     * @protected
     * @param {string} name
     * @param {object} [options]
     * @returns {{ index: ReadableIndex, matcher?: Object|function }}
     */
    createIndex(name, options = {}) {
        const { index } = super.createIndex(name, options);
        const indexShortName = name.replace(this.storageFile + '.', '').replace('.index', '');
        index.on('append', (prevLength, newLength) => {
            const entries = index.range(prevLength + 1, newLength);
            /* istanbul ignore if */
            if (entries === false) {
                return;
            }
            for (let entry of entries) {
                const document = this.readFrom(entry.partition, entry.position, entry.size);
                if (index === this.index) {
                    this.emit('wrote', document, entry, entry.position);
                } else {
                    this.emit('index-add', indexShortName, entry.number, document);
                }
            }
        });
        index.on('truncate', (prevLength, newLength) => {
            if (index === this.index) {
                this.emit('truncate', prevLength, newLength);
            }
        });
        return { index };
    }
}

module.exports = ReadOnlyStorage;
